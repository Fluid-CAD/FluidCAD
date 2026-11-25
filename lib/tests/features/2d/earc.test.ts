import { describe, it, expect } from "vitest";
import { setupOC, render } from "../../setup.js";
import sketch from "../../../core/sketch.js";
import extrude from "../../../core/extrude.js";
import copy from "../../../core/copy.js";
import mirror from "../../../core/mirror.js";
import split from "../../../core/split.js";
import rect from "../../../core/shapes/rect.js";
import { arc, circle, eArc, ellipse, line, offset, origin, xAxis, yAxis } from "../../../core/2d/index.js";
import {
  coincident, concentric, diameter, distance, equal, horizontal, radius, symmetric, tangent, vertical,
} from "../../../core/constraints/index.js";
import { SolvedEllipticalArc } from "../../../features/2d/solved/elliptical-arc.js";
import { MirrorShape2D } from "../../../features/mirror-shape2d.js";
import { Offset } from "../../../features/2d/offset.js";
import { Split } from "../../../features/split.js";
import { Sketch } from "../../../features/2d/sketch.js";
import { ExtrudeBase } from "../../../features/extrude-base.js";
import { SceneObject } from "../../../common/scene-object.js";
import { Edge } from "../../../common/edge.js";
import { Scene } from "../../../rendering/scene.js";
import { EdgeOps } from "../../../oc/edge-ops.js";
import { EdgeProps } from "../../../oc/edge-props.js";
import { ShapeOps } from "../../../oc/shape-ops.js";
import { ShapeProps } from "../../../oc/props.js";
import type { ICopy, IEllipticalArc, IMirror2D, ISceneObject } from "../../../core/interfaces.js";

// The eArc() statement: an open piece of an ellipse as a solver entity.
// What it registers, the edge it builds (which side, which end is which,
// with either semi-radius the longer), that a closed profile holding one
// extrudes, and that the constraints an ellipse and an arc take solve.

// Bounding boxes are read off the display mesh, which sits a hair outside
// the curve: they tell which piece of the ellipse was built, to the unit.
// Exact positions are read off the edge's own vertices.

function payloadOf(scene: Scene, obj: unknown) {
  return scene.getRenderedObject(obj as SceneObject).object;
}

function solverOf(scene: Scene, sk: unknown) {
  return payloadOf(scene, sk).solver;
}

/** The statement's one real edge. */
function edgeOf(obj: unknown): Edge {
  const edges = (obj as SceneObject).getShapes().filter(
    (shape): shape is Edge => shape instanceof Edge && !shape.isMetaShape(),
  );
  expect(edges).toHaveLength(1);
  return edges[0];
}

function endsOf(edge: Edge): { first: { x: number; y: number }; last: { x: number; y: number } } {
  const first = EdgeOps.getVertexPoint(EdgeOps.getFirstVertex(edge));
  const last = EdgeOps.getVertexPoint(EdgeOps.getLastVertex(edge));
  return { first: { x: first.x, y: first.y }, last: { x: last.x, y: last.y } };
}

describe("eArc", () => {
  setupOC();

  describe("the statement", () => {
    it("registers one elliptical arc entity with every literal a guess: seven degrees of freedom", () => {
      let ea: unknown;
      const sk = sketch("xy", () => {
        ea = eArc([40, 0], [0, 20], [0, 0], 40, 20);
      }) as unknown as Sketch;
      const scene = render();

      const solver = solverOf(scene, sk);
      const entities = solver.entities.filter((e: any) => e.id >= 0);
      expect(entities).toHaveLength(1);
      expect(entities[0].kind).toBe("eArc");
      expect(solver.dof).toBe(7);
      expect(solver.outcome).toBe("solved");

      const payload = payloadOf(scene, ea);
      expect(payload.center).toEqual({ x: 0, y: 0 });
      expect(payload.rx).toBeCloseTo(40, 9);
      expect(payload.ry).toBeCloseTo(20, 9);
      expect(payload.rotation).toBeCloseTo(0, 9);
      expect(payload.cw).toBe(false);
      expect(payload.start.x).toBeCloseTo(40, 9);
      expect(payload.end.y).toBeCloseTo(20, 9);
      // No rotation argument written: the guess carries none.
      expect(payload.guess).toEqual({
        start: { x: 40, y: 0 }, end: { x: 0, y: 20 }, center: { x: 0, y: 0 }, rx: 40, ry: 20,
      });
      expect((ea as SceneObject).getType()).toBe("eArc");
      expect((ea as SceneObject).getUniqueType()).toBe("solved-earc");
    });

    it("carries the rotation argument as a guess in degrees", () => {
      let ea: unknown;
      sketch("xy", () => {
        ea = eArc([0, 40], [-20, 0], [0, 0], 40, 20, 90);
      });
      const scene = render();
      const payload = payloadOf(scene, ea);
      expect(payload.rotation).toBeCloseTo(90, 9);
      expect(payload.guess.rotation).toBe(90);
      expect(payload.start.x).toBeCloseTo(0, 9);
      expect(payload.start.y).toBeCloseTo(40, 9);
    });

    it("reads an end literal that is off the ellipse as the ellipse point in its direction", () => {
      let ea: unknown;
      sketch("xy", () => {
        // Rounded and rough ends; the ellipse itself stays exactly as written.
        ea = eArc([41.3, 0.2], [0.4, 23], [0, 0], 40, 20);
      });
      const scene = render();
      const payload = payloadOf(scene, ea);
      expect(payload.rx).toBeCloseTo(40, 9);
      expect(payload.ry).toBeCloseTo(20, 9);
      expect(payload.center.x).toBeCloseTo(0, 9);
      for (const p of [payload.start, payload.end]) {
        expect((p.x * p.x) / 1600 + (p.y * p.y) / 400).toBeCloseTo(1, 9);
      }
      // The written literals are still what the write-back guards against.
      expect(payload.guess.start).toEqual({ x: 41.3, y: 0.2 });
    });

    it("needs all five arguments, points first", () => {
      expect(() => sketch("xy", () => { (eArc as any)([40, 0], [0, 20], [0, 0], 40); }))
        .toThrow(/eArc\(\) needs full specification/);
      expect(() => sketch("xy", () => { (eArc as any)([0, 0], 40, 20, 0, 90); }))
        .toThrow(/eArc\(\) needs full specification/);
      expect(() => sketch("xy", () => { eArc([40, 0], [0, 20], [0, 0], 40, 20, Number.NaN); }))
        .toThrow(/rotation must be a finite number/);
    });

    it("rejects zero or negative radii on the statement", () => {
      let ea: SolvedEllipticalArc | undefined;
      sketch("xy", () => {
        ea = eArc([40, 0], [0, 20], [0, 0], 0, 20) as unknown as SolvedEllipticalArc;
      });
      render();
      expect(ea?.getError()).toMatch(/positive/i);
    });
  });

  describe("the edge", () => {
    it("runs counter-clockwise from start to end by default", () => {
      let ea: unknown;
      sketch("xy", () => {
        ea = eArc([40, 0], [0, 20], [0, 0], 40, 20);
      });
      render();
      const edge = edgeOf(ea);
      expect(EdgeProps.getProperties(edge.getShape()).curveType).toBe("ellipse");
      const { first, last } = endsOf(edge);
      expect(first.x).toBeCloseTo(40, 7);
      expect(first.y).toBeCloseTo(0, 7);
      expect(last.x).toBeCloseTo(0, 7);
      expect(last.y).toBeCloseTo(20, 7);
      // The first quadrant's quarter only.
      const bbox = ShapeOps.getBoundingBox(edge);
      expect(bbox.minX).toBeCloseTo(0, 0);
      expect(bbox.maxX).toBeCloseTo(40, 0);
      expect(bbox.minY).toBeCloseTo(0, 0);
      expect(bbox.maxY).toBeCloseTo(20, 0);
    });

    it(".cw() takes the other three quarters, still from start to end", () => {
      let ea: unknown;
      sketch("xy", () => {
        ea = eArc([40, 0], [0, 20], [0, 0], 40, 20).cw();
      });
      const scene = render();
      expect(payloadOf(scene, ea).cw).toBe(true);
      const edge = edgeOf(ea);
      const { first, last } = endsOf(edge);
      expect(first.x).toBeCloseTo(40, 7);
      expect(first.y).toBeCloseTo(0, 7);
      expect(last.x).toBeCloseTo(0, 7);
      expect(last.y).toBeCloseTo(20, 7);
      const bbox = ShapeOps.getBoundingBox(edge);
      expect(bbox.minX).toBeCloseTo(-40, 0);
      expect(bbox.maxX).toBeCloseTo(40, 0);
      expect(bbox.minY).toBeCloseTo(-20, 0);
      expect(bbox.maxY).toBeCloseTo(20, 0);
    });

    it("builds the same arc when RY is the longer semi-radius", () => {
      let ea: unknown;
      sketch("xy", () => {
        ea = eArc([20, 0], [0, 40], [0, 0], 20, 40);
      });
      render();
      const edge = edgeOf(ea);
      const { first, last } = endsOf(edge);
      expect(first.x).toBeCloseTo(20, 7);
      expect(first.y).toBeCloseTo(0, 7);
      expect(last.x).toBeCloseTo(0, 7);
      expect(last.y).toBeCloseTo(40, 7);
      const bbox = ShapeOps.getBoundingBox(edge);
      expect(bbox.minX).toBeCloseTo(0, 0);
      expect(bbox.maxX).toBeCloseTo(20, 0);
      expect(bbox.maxY).toBeCloseTo(40, 0);
    });

    it("builds a rotated arc, clockwise, with RY the longer", () => {
      // The ellipse turned 90°: its RX (10) runs along Y, its RY (30) along X.
      let ea: unknown;
      sketch("xy", () => {
        ea = eArc([0, 10], [30, 0], [0, 0], 10, 30, 90).cw();
      });
      render();
      const edge = edgeOf(ea);
      const { first, last } = endsOf(edge);
      expect(first.x).toBeCloseTo(0, 7);
      expect(first.y).toBeCloseTo(10, 7);
      expect(last.x).toBeCloseTo(30, 7);
      expect(last.y).toBeCloseTo(0, 7);
      const bbox = ShapeOps.getBoundingBox(edge);
      expect(bbox.minX).toBeCloseTo(0, 0);
      expect(bbox.maxX).toBeCloseTo(30, 0);
      expect(bbox.minY).toBeCloseTo(0, 0);
      expect(bbox.maxY).toBeCloseTo(10, 0);
    });

    it("builds on a plane other than XY", () => {
      let ea: unknown;
      sketch("xz", () => {
        ea = eArc([40, 0], [0, 20], [0, 0], 40, 20);
      });
      render();
      const bbox = ShapeOps.getBoundingBox(edgeOf(ea));
      expect(bbox.maxX - bbox.minX).toBeCloseTo(40, 0);
      expect(bbox.maxZ - bbox.minZ).toBeCloseTo(20, 0);
      expect(bbox.maxY - bbox.minY).toBeCloseTo(0, 0);
    });

    it("coincident ends are the whole ellipse, never a sliver", () => {
      let ea: unknown;
      sketch("xy", () => {
        ea = eArc([40, 0], [40, 0], [0, 0], 40, 20);
      });
      render();
      const bbox = ShapeOps.getBoundingBox(edgeOf(ea));
      expect(bbox.maxX - bbox.minX).toBeCloseTo(80, 0);
      expect(bbox.maxY - bbox.minY).toBeCloseTo(40, 0);
    });
  });

  describe("in a profile", () => {
    it("a half ellipse closed by a line extrudes to the exact solid", () => {
      sketch("xy", () => {
        const ea = eArc([40, 0], [-40, 0], [0, 0], 40, 20);
        const l = line([-40, 0], [40, 0]);
        coincident(l.start(), ea.end());
        coincident(l.end(), ea.start());
      });
      const e = extrude(10) as ExtrudeBase;
      render();

      const solids = e.getShapes();
      expect(solids).toHaveLength(1);
      expect(solids[0].getType()).toBe("solid");
      const bbox = ShapeOps.getBoundingBox(solids[0]);
      expect(bbox.maxX - bbox.minX).toBeCloseTo(80, 0);
      expect(bbox.minY).toBeCloseTo(0, 0);
      expect(bbox.maxY).toBeCloseTo(20, 0);
      const props = ShapeProps.getProperties(solids[0].getShape());
      expect(props.volumeMm3).toBeCloseTo((Math.PI * 40 * 20 / 2) * 10, 1);
    });

    it("closes with literals alone, no constraints", () => {
      sketch("xy", () => {
        eArc([0, 20], [0, -20], [0, 0], 40, 20).cw();
        line([0, -20], [0, 20]);
      });
      const e = extrude(5) as ExtrudeBase;
      render();
      const solids = e.getShapes();
      expect(solids).toHaveLength(1);
      const props = ShapeProps.getProperties(solids[0].getShape());
      expect(props.volumeMm3).toBeCloseTo((Math.PI * 40 * 20 / 2) * 5, 1);
    });

    it("joins lines and a circular arc into one closed loop", () => {
      // A flat base, two walls, an elliptical crown.
      sketch("xy", () => {
        const base = line([-30, 0], [30, 0]);
        const right = line([30, 0], [30, 20]);
        const crown = eArc([30, 20], [-30, 20], [0, 20], 30, 12);
        const left = line([-30, 20], [-30, 0]);
        coincident(base.end(), right.start());
        coincident(right.end(), crown.start());
        coincident(crown.end(), left.start());
        coincident(left.end(), base.start());
      });
      const e = extrude(4) as ExtrudeBase;
      render();
      const solids = e.getShapes();
      expect(solids).toHaveLength(1);
      const props = ShapeProps.getProperties(solids[0].getShape());
      expect(props.volumeMm3).toBeCloseTo((60 * 20 + Math.PI * 30 * 12 / 2) * 4, 1);
    });
  });

  describe("constraints", () => {
    it("pins to zero degrees of freedom: center, orientation, both semi-radii, both ends", () => {
      let ea: unknown;
      const sk = sketch("xy", () => {
        const a = eArc([31, 2], [1, 16], [1, 1], 28, 14, 5);
        ea = a;
        coincident(a.center(), origin());
        horizontal(a);
        radius(a, 30, 'x');
        radius(a, 15, 'y');
        coincident(a.start(), xAxis());
        coincident(a.end(), yAxis());
      }) as unknown as Sketch;
      const scene = render();

      const solver = solverOf(scene, sk);
      expect(solver.outcome).toBe("solved");
      expect(solver.dof).toBe(0);
      expect(solver.redundant).toEqual([]);
      expect(solver.conflicting).toEqual([]);
      const payload = payloadOf(scene, ea);
      expect(payload.rx).toBeCloseTo(30, 6);
      expect(payload.ry).toBeCloseTo(15, 6);
      expect(payload.start.x).toBeCloseTo(30, 6);
      expect(payload.start.y).toBeCloseTo(0, 6);
      expect(payload.end.x).toBeCloseTo(0, 6);
      expect(payload.end.y).toBeCloseTo(15, 6);
      const { first, last } = endsOf(edgeOf(ea));
      expect(first.x).toBeCloseTo(30, 6);
      expect(last.y).toBeCloseTo(15, 6);
    });

    it("vertical() turns the RX axis up; the ends ride along on the ellipse", () => {
      let ea: unknown;
      sketch("xy", () => {
        const a = eArc([30, 0], [0, 15], [0, 0], 30, 15);
        ea = a;
        coincident(a.center(), origin());
        vertical(a);
        radius(a, 30, 'x');
        radius(a, 15, 'y');
      });
      const scene = render();
      const payload = payloadOf(scene, ea);
      expect(Math.abs(Math.cos(payload.rotation * Math.PI / 180))).toBeLessThan(1e-7);
      for (const p of [payload.start, payload.end]) {
        // RX now runs along Y.
        expect((p.y * p.y) / 900 + (p.x * p.x) / 225).toBeCloseTo(1, 6);
      }
    });

    it("tangent() at a joined line end, and at an end joined to an arc", () => {
      let sk: unknown;
      let ea: unknown;
      let l: unknown;
      let a: unknown;
      sk = sketch("xy", () => {
        const e = eArc([40, 0], [0, 20], [0, 0], 40, 20);
        ea = e;
        const lead = line([43, -25], [40, 0]);
        l = lead;
        const tail = arc([0, 20], [-12, 14], [-2, 9]);
        a = tail;
        coincident(e.center(), origin());
        horizontal(e);
        radius(e, 40, 'x');
        radius(e, 20, 'y');
        coincident(e.start(), xAxis());
        coincident(e.end(), yAxis());
        coincident(lead.end(), e.start());
        tangent(lead, e);
        coincident(tail.start(), e.end());
        tangent(e, tail);
      });
      const scene = render();
      const solver = solverOf(scene, sk);
      expect(solver.outcome).toBe("solved");
      expect(solver.redundant).toEqual([]);
      // At (40, 0) the ellipse runs straight up: the line is vertical.
      const lp = payloadOf(scene, l);
      expect(lp.start.x).toBeCloseTo(40, 6);
      // At (0, 20) it runs level: the arc's center sits straight below or above.
      const ap = payloadOf(scene, a);
      expect(ap.center.x).toBeCloseTo(0, 6);
      expect(payloadOf(scene, ea).start.x).toBeCloseTo(40, 6);
    });

    it("concentric(), equal(), a point on the outline and a tangent circle", () => {
      let ea: unknown;
      let twin: unknown;
      let c: unknown;
      const sk = sketch("xy", () => {
        const a = eArc([40, 0], [0, 20], [0, 0], 40, 20);
        ea = a;
        const el = ellipse([100, 0], 10, 8);
        twin = el;
        const bore = circle([3, 2], 8);
        c = bore;
        const touch = circle([60, 0], 30);
        const l = line([-50, 30], [10, 21]);
        coincident(a.center(), origin());
        horizontal(a);
        radius(a, 40, 'x');
        radius(a, 20, 'y');
        equal(a, el);
        concentric(a, bore);
        tangent(a, touch);
        coincident(l.end(), a);
      }) as unknown as Sketch;
      const scene = render();
      expect(solverOf(scene, sk).outcome).toBe("solved");
      expect(payloadOf(scene, twin).rx).toBeCloseTo(40, 6);
      expect(payloadOf(scene, twin).ry).toBeCloseTo(20, 6);
      expect(payloadOf(scene, c).center.x).toBeCloseTo(0, 6);
      expect(payloadOf(scene, c).center.y).toBeCloseTo(0, 6);
      expect(payloadOf(scene, ea).rx).toBeCloseTo(40, 6);
    });

    it("symmetric() mirrors one elliptical arc onto another", () => {
      let right: unknown;
      let left: unknown;
      const sk = sketch("xy", () => {
        const a = eArc([60, 5], [30, 20], [30, 5], 30, 15);
        right = a;
        const b = eArc([-58, 6], [-31, 21], [-29, 4], 28, 16, 180).cw();
        left = b;
        symmetric(a, b, yAxis());
      }) as unknown as Sketch;
      const scene = render();
      const solver = solverOf(scene, sk);
      expect(solver.outcome).toBe("solved");
      expect(solver.dof).toBe(7);
      expect(solver.redundant).toEqual([]);
      const pr = payloadOf(scene, right);
      const pl = payloadOf(scene, left);
      expect(pl.center.x).toBeCloseTo(-pr.center.x, 6);
      expect(pl.start.x).toBeCloseTo(-pr.start.x, 6);
      expect(pl.end.y).toBeCloseTo(pr.end.y, 6);
      expect(pl.rx).toBeCloseTo(pr.rx, 6);
    });

    it("distance() between its points works; the refused forms say why", () => {
      let d1: unknown;
      let noAxis: unknown;
      let dia: unknown;
      let toCurve: unknown;
      const sk = sketch("xy", () => {
        const a = eArc([40, 0], [0, 20], [0, 0], 40, 20);
        const l = line([60, 0], [60, 30]);
        d1 = distance(a.start(), a.end(), 50);
        noAxis = radius(a, 40);
        dia = diameter(a, 80);
        toCurve = distance(l.start(), a, 10);
      }) as unknown as Sketch;
      const scene = render();
      expect((d1 as SceneObject).getError()).toBeFalsy();
      expect((noAxis as SceneObject).getError()).toMatch(/needs the axis/);
      expect((dia as SceneObject).getError()).toMatch(/an elliptical arc has two semi-radii/);
      expect((toCurve as SceneObject).getError()).toMatch(/an elliptical arc has two semi-radii/);
      expect(solverOf(scene, sk).outcome).toBe("solved");
    });
  });

  describe("the documented arch", () => {
    // website/docs/sketching/_examples/primitive-elliptical-arc.js, statement
    // for statement: the page promises a fully constrained profile.
    it("is fully constrained with no redundant row, and extrudes", () => {
      let crownArc: unknown;
      const sk = sketch("xy", () => {
        const sill = line([0, 0], [60, 0]);
        const right = line([60, 0], [60, 40]);
        const crown = eArc([60, 40], [0, 40], [30, 40], 30, 18);
        crownArc = crown;
        const left = line([0, 40], [0, 0]);
        coincident(sill.end(), right.start());
        coincident(right.end(), crown.start());
        coincident(crown.end(), left.start());
        coincident(left.end(), sill.start());
        tangent(right, crown);
        tangent(crown, left);
        horizontal(sill);
        vertical(right);
        vertical(left);
        horizontal(crown);
        coincident(sill.start(), origin());
        distance(sill.start(), sill.end(), 60);
        distance(right.start(), right.end(), 40);
        radius(crown, 18, 'y');
      }) as unknown as Sketch;
      const e = extrude(5) as ExtrudeBase;
      const scene = render();

      const solver = solverOf(scene, sk);
      expect(solver.outcome).toBe("solved");
      expect(solver.dof).toBe(0);
      expect(solver.redundant).toEqual([]);
      expect(solver.conflicting).toEqual([]);
      const payload = payloadOf(scene, crownArc);
      // The width sets RX; the crown rises 18 above the jambs.
      expect(payload.rx).toBeCloseTo(30, 6);
      expect(payload.ry).toBeCloseTo(18, 6);
      expect(payload.center.x).toBeCloseTo(30, 6);
      expect(payload.center.y).toBeCloseTo(40, 6);
      const solids = e.getShapes();
      expect(solids).toHaveLength(1);
      const props = ShapeProps.getProperties(solids[0].getShape());
      expect(props.volumeMm3).toBeCloseTo((60 * 40 + Math.PI * 30 * 18 / 2) * 5, 1);
    });
  });

  describe("offset()", () => {
    it("offsets an elliptical arc as a derived edge", () => {
      let o: Offset;
      sketch("xy", () => {
        const ea = eArc([40, 0], [0, 20], [0, 0], 40, 20);
        o = offset(5, ea) as unknown as Offset;
      });
      const scene = render();
      expect(scene.getRenderedObject(o! as unknown as SceneObject).errorMessage ?? null).toBeNull();
      const edges = o!.getShapes().filter((shape): shape is Edge => shape instanceof Edge);
      expect(edges.length).toBeGreaterThanOrEqual(1);
      expect(edges.every(edge => edge.provenance === 'offset-of')).toBe(true);
    });
  });

  describe("as a split seed", () => {
    it("cuts a solid along the sheet the arc sweeps", () => {
      // 40 × 30 × 10 block centred on the origin; the arc bulges through it
      // from the left, entering and leaving through the long faces.
      sketch("xy", () => {
        rect([-20, -15], 40, 30);
      });
      extrude(10);
      let seed: any;
      sketch("xy", () => {
        seed = eArc([0, -40], [0, 40], [-30, 0], 40, 40.5).guide();
      });
      const s = split(seed) as unknown as Split;
      render();

      const pieces = s.getShapes();
      expect(s.getError()).toBeNull();
      expect(pieces.length).toBe(2);
      expect(pieces.every(p => p.isSolid())).toBe(true);
      const total = pieces.reduce((sum, p) => sum + ShapeProps.getProperties(p.getShape()).volumeMm3, 0);
      expect(total).toBeCloseTo(40 * 30 * 10, 2);
    });
  });

  describe("mirror and copy", () => {
    it("mirror() images an elliptical arc as a tied elliptical arc entity", () => {
      let src: IEllipticalArc;
      let m: IMirror2D;
      const sk = sketch("xy", () => {
        src = eArc([60, 0], [30, 15], [30, 0], 30, 15);
        m = mirror(yAxis(), src);
      }) as unknown as Sketch;
      const scene = render();

      const payload = (m! as unknown as MirrorShape2D).serialize() as {
        entities?: { entityId: number; kind: string; sourceEntityId: number }[];
      };
      expect(payload.entities).toHaveLength(1);
      expect(payload.entities![0].kind).toBe("eArc");
      const solver = solverOf(scene, sk);
      expect(solver.outcome).toBe("solved");
      // The image adds no freedom of its own.
      expect(solver.dof).toBe(7);
      const image = solver.entities.find((e: any) => e.id === payload.entities![0].entityId);
      const p = solver.params.slice(image.paramOffset, image.paramOffset + 9);
      expect(p[0]).toBeCloseTo(-30, 6);
      expect(p[5]).toBeCloseTo(-60, 6);
      expect(p[7]).toBeCloseTo(-30, 6);
      expect(p[8]).toBeCloseTo(15, 6);
      // The stamped image is the reflected edge.
      const bbox = ShapeOps.getBoundingBox(edgeOf(m!));
      expect(bbox.minX).toBeCloseTo(-60, 0);
      expect(bbox.maxX).toBeCloseTo(-30, 0);
      expect(bbox.maxY).toBeCloseTo(15, 0);
    });

    it("a constraint on the mirror image drives the source", () => {
      let src: IEllipticalArc;
      const sk = sketch("xy", () => {
        src = eArc([60, 0], [30, 15], [30, 0], 30, 15);
        const m = mirror(yAxis(), src) as IMirror2D;
        radius(m.instance(src) as unknown as ISceneObject, 24, 'x');
      }) as unknown as Sketch;
      const scene = render();
      expect(solverOf(scene, sk).outcome).toBe("solved");
      expect(payloadOf(scene, src!).rx).toBeCloseTo(24, 6);
    });

    it("copy() duplicates register as tied elliptical arcs with all three point accessors", () => {
      let src: IEllipticalArc;
      let cp: ICopy;
      const sk = sketch("xy", () => {
        src = eArc([40, 0], [0, 20], [0, 0], 40, 20);
        cp = copy('linear', 'x', { count: 2, offset: 100 }, src) as ICopy;
        const dup = (cp as any).instance(1);
        coincident(dup.center(), xAxis());
        distance(dup.start(), dup.end(), 45);
      }) as unknown as Sketch;
      const scene = render();
      const solver = solverOf(scene, sk);
      expect(solver.outcome).toBe("solved");
      const kinds = solver.entities.filter((e: any) => e.id >= 0).map((e: any) => e.kind);
      expect(kinds).toEqual(["eArc", "eArc"]);
      // 7 for the source, none for the tied duplicate, minus the two rows.
      expect(solver.dof).toBe(5);
      const p = payloadOf(scene, src!);
      expect(Math.hypot(p.end.x - p.start.x, p.end.y - p.start.y)).toBeCloseTo(45, 6);
    });
  });
});
