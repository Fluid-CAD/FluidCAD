import { describe, it, expect } from "vitest";
import { setupOC, render } from "./setup.js";
import { getSceneManager } from "../scene-manager.js";
import sketch from "../core/sketch.js";
import extrude from "../core/extrude.js";
import select from "../core/select.js";
import part from "../core/part.js";
import connector from "../core/connector.js";
import { circle } from "../core/2d/index.js";
import { testRect } from "./helpers/profiles.js";
import { face } from "../filters/index.js";
import { Connector } from "../features/connector.js";
import { IExtrude, ISelection } from "../core/interfaces.js";
import { Point } from "../math/point.js";
import { Edge } from "../common/edge.js";
import { Explorer } from "../oc/explorer.js";
import { EdgeOps } from "../oc/edge-ops.js";
import { EdgeQuery } from "../oc/edge-query.js";
import { anchorFromShape, VertexAnchorSpec } from "../features/shape-anchor.js";
import { findSolid } from "./selection/pick-helpers.js";
import type { TopoDS_Edge } from "ocjs-fluidcad";

// rect(40, 60) on 'xy' extruded 20 → box (0..40, 0..60, 0..20).
function boxPart(name: string, body: (e: IExtrude) => void) {
  part(name, () => {
    sketch("xy", () => { testRect(40, 60); });
    const e = extrude(20);
    body(e as unknown as IExtrude);
  });
  render();
}

// circle(10) on 'xy' extruded 15 → cylinder r=10, z 0..15.
function cylinderPart(name: string, body: (e: IExtrude) => void) {
  part(name, () => {
    sketch("xy", () => { circle([0, 0], 10); });
    const e = extrude(15);
    body(e as unknown as IExtrude);
  });
  render();
}

describe("anchored vertex references", () => {
  setupOC();

  it("select(face()).center() anchors origin and Z to the face, not world Z", () => {
    let conn!: Connector;
    boxPart("face-center", () => {
      conn = connector("c", select(face().planar().onPlane("yz", 40)).center()) as unknown as Connector;
    });

    const frame = conn.getFrame();
    // +X side face of the box: center (40, 30, 10), normal +X.
    expect(frame.origin.x).toBeCloseTo(40, 5);
    expect(frame.origin.y).toBeCloseTo(30, 5);
    expect(frame.origin.z).toBeCloseTo(10, 5);
    expect(Math.abs(frame.normal.x)).toBeCloseTo(1, 5);
    expect(frame.normal.y).toBeCloseTo(0, 5);
    expect(frame.normal.z).toBeCloseTo(0, 5);
  });

  it("endFaces().center() uses the first end face", () => {
    let conn!: Connector;
    boxPart("end-center", (e) => {
      conn = connector("c", e.endFaces().center()) as unknown as Connector;
    });

    const frame = conn.getFrame();
    // Top face of the box: center (20, 30, 20), normal +Z.
    expect(frame.origin.x).toBeCloseTo(20, 5);
    expect(frame.origin.y).toBeCloseTo(30, 5);
    expect(frame.origin.z).toBeCloseTo(20, 5);
    expect(frame.normal.z).toBeCloseTo(1, 5);
  });

  it("center() of a circular edge is the circle center with the circle axis as Z", () => {
    let conn!: Connector;
    cylinderPart("circle-center", (e) => {
      conn = connector("c", e.endEdges(0).center()) as unknown as Connector;
    });

    const frame = conn.getFrame();
    // Top circle of the cylinder: center (0, 0, 15), axis ±Z.
    expect(frame.origin.x).toBeCloseTo(0, 5);
    expect(frame.origin.y).toBeCloseTo(0, 5);
    expect(frame.origin.z).toBeCloseTo(15, 5);
    expect(Math.abs(frame.normal.z)).toBeCloseTo(1, 5);
  });

  it("start()/end()/offset() walk a straight edge consistently", () => {
    const conns: Record<string, Connector> = {};
    boxPart("edge-walk", (e) => {
      const target = () => e.startEdges(0) as unknown as ISelection;
      conns.start = connector("s", target().start()) as unknown as Connector;
      conns.end = connector("e", target().end()) as unknown as Connector;
      conns.center = connector("c", target().center()) as unknown as Connector;
      conns.rel = connector("r", target().offset("relative", 0.3)) as unknown as Connector;
      conns.absFwd = connector("af", target().offset("absolute", 5)) as unknown as Connector;
      conns.absBack = connector("ab", target().offset("absolute", -5)) as unknown as Connector;
    });

    const start = conns.start.getFrame().origin;
    const end = conns.end.getFrame().origin;
    const length = start.distanceTo(end);

    // A bottom-rectangle edge: on z=0, length is one of the rect sides.
    expect(start.z).toBeCloseTo(0, 5);
    expect(end.z).toBeCloseTo(0, 5);
    expect([40, 60]).toContainEqual(Math.round(length));

    const lerp = (t: number) => start.lerp(end, t);
    const expectAt = (conn: Connector, expected: Point) => {
      const origin = conn.getFrame().origin;
      expect(origin.x).toBeCloseTo(expected.x, 5);
      expect(origin.y).toBeCloseTo(expected.y, 5);
      expect(origin.z).toBeCloseTo(expected.z, 5);
    };

    expectAt(conns.center, lerp(0.5));
    expectAt(conns.rel, lerp(0.3));
    expectAt(conns.absFwd, lerp(5 / length));
    expectAt(conns.absBack, lerp(1 - 5 / length));

    // Line-edge anchors take the oriented tangent (start → end) as Z.
    const tangent = start.vectorTo(end).normalize();
    const frameZ = conns.center.getFrame().normal;
    expect(frameZ.dot(tangent)).toBeCloseTo(1, 5);
  });

  it("offset('absolute') beyond the edge length surfaces a build error", () => {
    let conn!: Connector;
    boxPart("abs-overrun", (e) => {
      conn = connector("c", (e.startEdges(0) as unknown as ISelection).offset("absolute", 1000)) as unknown as Connector;
    });
    expect(conn.getError()).toContain("exceeds the edge length");
  });

  it("offset('absolute') on a circular edge surfaces a build error", () => {
    let conn!: Connector;
    cylinderPart("abs-on-circle", (e) => {
      conn = connector("c", (e.endEdges(0) as unknown as ISelection).offset("absolute", 5)) as unknown as Connector;
    });
    expect(conn.getError()).toContain("straight line edges");
  });

  it("start() on a face selection surfaces a build error", () => {
    let conn!: Connector;
    boxPart("start-on-face", (e) => {
      conn = connector("c", e.endFaces().start()) as unknown as Connector;
    });
    expect(conn.getError()).toContain("a face only supports center()");
  });

  it("offset() validates mode and value at call time", () => {
    expect(() => {
      part("bad-mode", () => {
        sketch("xy", () => { testRect(40, 60); });
        const e = extrude(20) as unknown as IExtrude;
        (e.startEdges(0) as unknown as any).offset("sideways", 5);
      }).materialize();
    }).toThrow(/mode must be 'relative' or 'absolute'/);

    expect(() => {
      part("bad-value", () => {
        sketch("xy", () => { testRect(40, 60); });
        const e = extrude(20) as unknown as IExtrude;
        (e.startEdges(0) as unknown as ISelection).offset("relative", Number.NaN);
      }).materialize();
    }).toThrow(/finite number/);
  });

  it("relative offsets outside 0..1 surface a build error", () => {
    let conn!: Connector;
    boxPart("rel-overrun", (e) => {
      conn = connector("c", (e.startEdges(0) as unknown as ISelection).offset("relative", 1.5)) as unknown as Connector;
    });
    expect(conn.getError()).toContain("between 0");
  });

  it("identical anchored connectors compare equal; different anchors do not", () => {
    // Mirror SceneCompare's real usage: each build lives in a fresh scene so
    // order-based unique names line up (like the serialized-frame cache test).
    function buildScene(value: number): Connector {
      getSceneManager().startScene();
      let conn!: Connector;
      boxPart("cmp", (e) => {
        conn = connector("c", (e.startEdges(0) as unknown as ISelection).offset("relative", value)) as unknown as Connector;
      });
      return conn;
    }

    const a = buildScene(0.3);
    const b = buildScene(0.3);
    const c = buildScene(0.4);

    expect(a.compareTo(b)).toBe(true);
    expect(a.compareTo(c)).toBe(false);
  });

  it("edge anchors ignore topological orientation (reversed copies agree)", () => {
    // The bug this pins: the same physical edge reaches the frame math as
    // FORWARD from one face's wire and REVERSED from its neighbor's,
    // depending on which selection path resolved it — the frame must not
    // care which copy it got.
    part("orientation-free", () => {
      sketch("xy", () => { testRect(40, 60); });
      extrude(20);
    });
    const scene = render();
    const solid = findSolid(scene);
    const edges = Explorer.findEdgesWrapped(solid) as Edge[];
    const top = edges.filter(e => Math.abs(EdgeOps.getEdgeMidPoint(e).z - 20) < 1e-6
      && EdgeQuery.getEdgeCurveType(e) === "line");
    expect(top.length).toBeGreaterThan(0);

    const specs: VertexAnchorSpec[] = [
      { kind: "center" },
      { kind: "start" },
      { kind: "end" },
      { kind: "offset", mode: "relative", value: 0.3 },
      { kind: "offset", mode: "absolute", value: 5 },
    ];
    for (const edge of top) {
      const reversed = Edge.fromTopoDSEdge(EdgeOps.reverseEdgeRaw(edge.getShape() as TopoDS_Edge));
      for (const spec of specs) {
        const a = anchorFromShape(edge, spec);
        const b = anchorFromShape(reversed, spec);
        expect(b.origin.x).toBeCloseTo(a.origin.x, 6);
        expect(b.origin.y).toBeCloseTo(a.origin.y, 6);
        expect(b.origin.z).toBeCloseTo(a.origin.z, 6);
        expect(b.zDir.dot(a.zDir)).toBeCloseTo(1, 6);
      }
    }
  });

  it("straight-edge Z leans positive along the leading world axis", () => {
    part("canonical-z", () => {
      sketch("xy", () => { testRect(40, 60); });
      extrude(20);
    });
    const scene = render();
    const solid = findSolid(scene);
    const edges = Explorer.findEdgesWrapped(solid) as Edge[];
    for (const edge of edges) {
      if (EdgeQuery.getEdgeCurveType(edge) !== "line") {
        continue;
      }
      const z = anchorFromShape(edge, { kind: "center" }).zDir;
      // Box edges are axis-aligned: the canonical rule puts the dominant
      // component strictly positive.
      const dominant = [z.x, z.y, z.z].reduce((a, b) => Math.abs(b) > Math.abs(a) ? b : a);
      expect(dominant).toBeGreaterThan(0);
    }
  });

  it("honors options.xDirection on anchored sources", () => {
    let conn!: Connector;
    boxPart("anchored-xdir", (e) => {
      conn = connector("c", e.endFaces().center(), { xDirection: "y" }) as unknown as Connector;
    });

    const frame = conn.getFrame();
    expect(frame.normal.z).toBeCloseTo(1, 5);
    expect(frame.xDirection.y).toBeCloseTo(1, 5);
    expect(frame.xDirection.x).toBeCloseTo(0, 5);
  });
});
