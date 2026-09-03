import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import part from "../../core/part.js";
import select from "../../core/select.js";
import connector from "../../core/connector.js";
import { circle, line } from "../../core/2d/index.js";
import { coincident } from "../../core/constraints/index.js";
import { face } from "../../filters/index.js";
import { Scene } from "../../rendering/scene.js";
import { synthesizeApplyFeature } from "../../selection/explain.js";
import { scopedSceneBefore } from "../../selection/types.js";
import { suggestConnectorAnchors } from "../../selection/connector-anchors.js";
import { edgeRefsWhere, faceRefsWhere, findSolid, findSolids, setLocation } from "./pick-helpers.js";
import { Connector } from "../../features/connector.js";
import { Edge } from "../../common/edge.js";
import { Explorer } from "../../oc/explorer.js";
import { EdgeOps } from "../../oc/edge-ops.js";
import { IExtrude, ISelection } from "../../core/interfaces.js";
import { testRect } from "../helpers/profiles.js";

/** Solved stand-in for legacy `polygon(n, dia)` (inscribed) centered at `at`. */
function testPolygon(n: number, dia: number, at: [number, number]) {
  const r = dia / 2;
  const pts: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    pts.push([at[0] + r * Math.cos(a), at[1] + r * Math.sin(a)]);
  }
  const lines = pts.map((p, i) => line(p, pts[(i + 1) % n]));
  for (let i = 0; i < n; i++) {
    coincident(lines[i].end(), lines[(i + 1) % n].start());
  }
}

describe("connector synthesis", () => {
  setupOC();

  /** One part around a 100×50×30 box; the part's call site is line 2. */
  function makePartScene(): { scene: Scene; topFace: ReturnType<typeof faceRefsWhere>[number] } {
    const p = part("housing", () => {
      sketch("xy", () => {
          testRect(100, 50);
        });
      const e = extrude(30);
      setLocation(e, 5);
    });
    setLocation(p, 2);
    const scene = render();
    const solid = findSolid(scene);
    const tops = faceRefsWhere(solid, m => Math.abs(m.z - 30) < 1e-6);
    expect(tops).toHaveLength(1);
    return { scene, topFace: tops[0] };
  }

  it("synthesizes a named connector spec carrying the part's call site", () => {
    const { scene, topFace } = makePartScene();

    const result = synthesizeApplyFeature(scene, [topFace], 'connector', 'mountTop');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.preview).toBe(`connector('mountTop', ${result.args})`);
      expect(result.spec.connector).toEqual({
        name: 'mountTop',
        part: { line: 2, column: 0 },
      });
      // The name rides the payload, not the numeric value channel.
      expect(result.spec.value).toBeUndefined();
      expect(result.spec.parts).toHaveLength(1);
    }
  });

  it("refuses a pick outside any part() block", () => {
    sketch("xy", () => {
        testRect(100, 50);
      });
    const e = extrude(30);
    setLocation(e, 3);
    const scene = render();
    const solid = findSolid(scene);
    const tops = faceRefsWhere(solid, m => Math.abs(m.z - 30) < 1e-6);

    const result = synthesizeApplyFeature(scene, tops, 'connector', 'mount');
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.reason).toContain('part()');
    }
  });

  it("edit mode keeps the edited connector's own name and still refuses a sibling's", () => {
    const p = part("housing", () => {
      sketch("xy", () => {
          testRect(100, 50);
        });
      const e = extrude(30);
      setLocation(e, 5);
      connector("mountTop", select(face().planar().onPlane("xy", 30)));
      connector("mountBottom", select(face().planar().onPlane("xy", 0)));
    });
    setLocation(p, 2);
    const scene = render();
    const solid = findSolid(scene);
    const tops = faceRefsWhere(solid, m => Math.abs(m.z - 30) < 1e-6);
    expect(tops).toHaveLength(1);
    const edited = scene.getAllSceneObjects()
      .findIndex(o => o instanceof Connector && o.connectorName === "mountTop");
    expect(edited).toBeGreaterThan(0);
    const scoped = scopedSceneBefore(scene, edited);

    // Re-picking the source under the statement's own name is not a clash.
    const kept = synthesizeApplyFeature(scoped, tops, 'connector', 'mountTop');
    expect(kept.ok).toBe(true);

    // A sibling declared AFTER the edited statement still owns its name.
    const sibling = synthesizeApplyFeature(scoped, tops, 'connector', 'mountBottom');
    expect(sibling.ok).toBe(false);
    if (sibling.ok === false) {
      expect(sibling.reason).toContain('already has a connector named "mountBottom"');
    }
  });

  it("refuses a name the part already registered", () => {
    const p = part("housing", () => {
      sketch("xy", () => {
          testRect(100, 50);
        });
      const e = extrude(30);
      setLocation(e, 5);
      connector("mountTop", select(face().planar().onPlane("xy", 30)));
    });
    setLocation(p, 2);
    const scene = render();
    const solid = findSolid(scene);
    const tops = faceRefsWhere(solid, m => Math.abs(m.z - 30) < 1e-6);
    expect(tops).toHaveLength(1);

    const result = synthesizeApplyFeature(scene, tops, 'connector', 'mountTop');
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.reason).toContain('already has a connector named "mountTop"');
    }

    // A fresh name on the same pick is fine.
    const fresh = synthesizeApplyFeature(scene, tops, 'connector', 'mountTop2');
    expect(fresh.ok).toBe(true);
  });

  it("refuses more than one pick", () => {
    const { scene, topFace } = makePartScene();
    const solid = findSolid(scene);
    const bottoms = faceRefsWhere(solid, m => Math.abs(m.z) < 1e-6);
    expect(bottoms).toHaveLength(1);

    const result = synthesizeApplyFeature(scene, [topFace, bottoms[0]], 'connector', 'mount');
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.reason).toContain('exactly one');
    }
  });

  it("refuses a missing or non-identifier name", () => {
    const { scene, topFace } = makePartScene();

    for (const bad of [undefined, 4, '', 'top left', '1st'] as const) {
      const result = synthesizeApplyFeature(scene, [topFace], 'connector', bad as any);
      expect(result.ok).toBe(false);
      if (result.ok === false) {
        expect(result.reason).toContain('name');
      }
    }
  });

  it("appends the anchor suffix to args and stores it on the spec", () => {
    const { scene, topFace } = makePartScene();

    const result = synthesizeApplyFeature(scene, [topFace], 'connector', 'mountTop', [], {
      connector: { anchor: { kind: 'center' } },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.args.endsWith('.center()')).toBe(true);
      expect(result.preview).toBe(`connector('mountTop', ${result.args})`);
      expect(result.spec.connector?.anchor).toEqual({ kind: 'center' });
      for (const alt of result.alternatives) {
        expect(alt.endsWith('.center()')).toBe(true);
      }
    }
  });

  it("renders the rotate/offset chain after the call, trimming trailing zeros", () => {
    const { scene, topFace } = makePartScene();

    const result = synthesizeApplyFeature(scene, [topFace], 'connector', 'mountTop', [], {
      connector: { anchor: { kind: 'center' }, rotate: { axis: 'z', angle: 90 }, offset: [5, 0, 0] },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.preview).toBe(`connector('mountTop', ${result.args}).rotate('z', 90).offset(5)`);
      expect(result.spec.connector?.rotate).toEqual({ axis: 'z', angle: 90 });
      expect(result.spec.connector?.offset).toEqual([5, 0, 0]);
    }

    // The dropdown's other axes render the same chain around x/y.
    const aroundX = synthesizeApplyFeature(scene, [topFace], 'connector', 'mountTop', [], {
      connector: { rotate: { axis: 'x', angle: 180 } },
    });
    expect(aroundX.ok).toBe(true);
    if (aroundX.ok) {
      expect(aroundX.preview).toBe(`connector('mountTop', ${aroundX.args}).rotate('x', 180)`);
      expect(aroundX.spec.connector?.rotate).toEqual({ axis: 'x', angle: 180 });
    }

    const zOnly = synthesizeApplyFeature(scene, [topFace], 'connector', 'mountTop', [], {
      connector: { offset: [0, 0, 5] },
    });
    expect(zOnly.ok).toBe(true);
    if (zOnly.ok) {
      expect(zOnly.preview).toBe(`connector('mountTop', ${zOnly.args}).offset(0, 0, 5)`);
    }

    // A full-turn rotation and an all-zero offset render nothing.
    const noop = synthesizeApplyFeature(scene, [topFace], 'connector', 'mountTop', [], {
      connector: { rotate: { axis: 'y', angle: 360 }, offset: [0, 0, 0] },
    });
    expect(noop.ok).toBe(true);
    if (noop.ok) {
      expect(noop.preview).toBe(`connector('mountTop', ${noop.args})`);
      expect(noop.spec.connector?.rotate).toBeUndefined();
      expect(noop.spec.connector?.offset).toBeUndefined();
    }
  });

  it("edge anchors synthesize offset forms", () => {
    const { scene } = makePartScene();
    const solid = findSolid(scene);
    const topEdges = edgeRefsWhere(solid, m => Math.abs(m.z - 30) < 1e-6);
    expect(topEdges.length).toBeGreaterThan(0);

    const result = synthesizeApplyFeature(scene, [topEdges[0]], 'connector', 'mountTop', [], {
      connector: { anchor: { kind: 'offset', mode: 'relative', value: 0.3 } },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.args.endsWith(".offset('relative', 0.3)")).toBe(true);
    }
  });

  it("refuses edge-only anchors on a face pick", () => {
    const { scene, topFace } = makePartScene();

    const result = synthesizeApplyFeature(scene, [topFace], 'connector', 'mountTop', [], {
      connector: { anchor: { kind: 'start' } },
    });
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.reason).toContain('needs an edge');
    }
  });

  it("suggests anchors with exact frames and a free default name", () => {
    const { scene, topFace } = makePartScene();

    const suggestion = suggestConnectorAnchors(scene, topFace);
    expect(suggestion.ok).toBe(true);
    if (suggestion.ok) {
      expect(suggestion.defaultName).toBe('c1');
      expect(suggestion.args.length).toBeGreaterThan(0);
      expect(suggestion.anchors).toHaveLength(1);
      const anchor = suggestion.anchors[0];
      expect(anchor.anchor).toEqual({ kind: 'center' });
      expect(anchor.suffix).toBe('.center()');
      // 100×50×30 box: top face center (50, 25, 30), normal +Z.
      expect(anchor.frame.origin.x).toBeCloseTo(50, 5);
      expect(anchor.frame.origin.y).toBeCloseTo(25, 5);
      expect(anchor.frame.origin.z).toBeCloseTo(30, 5);
      expect(anchor.frame.normal.z).toBeCloseTo(1, 5);
    }

    const solid = findSolid(scene);
    const topEdges = edgeRefsWhere(solid, m => Math.abs(m.z - 30) < 1e-6);
    const edgeSuggestion = suggestConnectorAnchors(scene, topEdges[0]);
    expect(edgeSuggestion.ok).toBe(true);
    if (edgeSuggestion.ok) {
      // A straight box edge: center + start + end.
      expect(edgeSuggestion.anchors.map(a => a.anchor.kind)).toEqual(['center', 'start', 'end']);
      for (const a of edgeSuggestion.anchors) {
        expect(a.frame.origin.z).toBeCloseTo(30, 5);
      }
    }
  });

  it("default names skip connectors the part already registered", () => {
    const p = part("housing", () => {
      sketch("xy", () => {
          testRect(100, 50);
        });
      const e = extrude(30);
      setLocation(e, 5);
      connector("c1", select(face().planar().onPlane("xy", 30)));
    });
    setLocation(p, 2);
    const scene = render();
    const solid = findSolid(scene);
    const bottoms = faceRefsWhere(solid, m => Math.abs(m.z) < 1e-6);
    expect(bottoms).toHaveLength(1);

    const suggestion = suggestConnectorAnchors(scene, bottoms[0]);
    expect(suggestion.ok).toBe(true);
    if (suggestion.ok) {
      expect(suggestion.defaultName).toBe('c2');
    }
  });

  it("suggestion frames match the applied statement's frame on every end edge", () => {
    // The Z-flip regression: a hover pick resolves the edge by exploring the
    // solid, while `e.endEdges(i)` reads it from classified face state — the
    // two copies carry opposite topological orientations, and an
    // orientation-signed tangent flipped the frame between the suggestion
    // gizmo and the applied connector.
    const conns: Connector[] = [];
    const p = part("housing", () => {
      sketch("xy", () => {
          testRect(100, 50);
        });
      const e = extrude(30) as unknown as IExtrude;
      setLocation(e, 5);
      for (let i = 0; i < 4; i++) {
        conns.push(connector(`edge${i}`, (e.endEdges(i) as unknown as ISelection).center()) as unknown as Connector);
      }
    });
    setLocation(p, 2);
    const scene = render();
    const solid = findSolid(scene);
    const solidEdges = Explorer.findEdgesWrapped(solid);

    for (const conn of conns) {
      const built = conn.getFrame();
      // Locate the same physical edge among the solid's explored edges — the
      // index a viewport pick would carry.
      const mid = built.origin;
      const index = solidEdges.findIndex(e => {
        const m = EdgeOps.getEdgeMidPoint(e as Edge);
        return Math.hypot(m.x - mid.x, m.y - mid.y, m.z - mid.z) < 1e-6;
      });
      expect(index).toBeGreaterThanOrEqual(0);

      const suggestion = suggestConnectorAnchors(scene, {
        shapeId: solid.id,
        sub: { type: 'edge', index },
      });
      expect(suggestion.ok).toBe(true);
      if (suggestion.ok) {
        const center = suggestion.anchors.find(a => a.anchor.kind === 'center')!;
        expect(center.frame.origin.x).toBeCloseTo(built.origin.x, 6);
        expect(center.frame.origin.y).toBeCloseTo(built.origin.y, 6);
        expect(center.frame.origin.z).toBeCloseTo(built.origin.z, 6);
        const dot = center.frame.normal.x * built.normal.x
          + center.frame.normal.y * built.normal.y
          + center.frame.normal.z * built.normal.z;
        expect(dot).toBeCloseTo(1, 6);
        const xDot = center.frame.xDirection.x * built.xDirection.x
          + center.frame.xDirection.y * built.xDirection.y
          + center.frame.xDirection.z * built.xDirection.z;
        expect(xDot).toBeCloseTo(1, 6);
      }
    }
  });

  it("prefers the index form when the filter would bake a full-precision constant", () => {
    // Polygon end edge: the only isolating filter is
    // `edge().line(63.30447167189937).above('yz').above('xz', -200)` — a
    // measured side length no dimension edit tracks. The connector must be
    // written on the index form, keeping the filter as an alternative.
    const p = part("mypart", () => {
      sketch("xy", () => {
        circle([50, 70], 35.77);
        // Legacy pen walk: move(33.66, 7.54) from [50, 70] put the rect corner
        // at [83.66, 77.54]; the second rect started at the pen's [150, 100];
        // the pentagon's center landed at [0, 170].
        testRect(110.99, -51.9, { at: [83.66, 77.54] });
        circle([150, 100], 72.84);
        testRect(83.74, -54.35, { at: [150, 100] });
        testPolygon(5, 107.7, [0, 170]);
      });
      const e = extrude();
      setLocation(e, 15);
    });
    setLocation(p, 2);
    const scene = render();

    let ref: { shapeId: string; sub: { type: 'edge'; index: number } } | null = null;
    for (const solid of findSolids(scene)) {
      const refs = edgeRefsWhere(solid, m =>
        Math.abs(m.z - 25) < 1e-6 && Math.abs(m.x - 35.25) < 0.05 && Math.abs(m.y - 144.39) < 0.05);
      if (refs.length === 1) {
        ref = refs[0] as typeof ref;
        break;
      }
    }
    expect(ref).not.toBeNull();

    const result = synthesizeApplyFeature(scene, [ref!], 'connector', 'c4', [], {
      connector: { anchor: { kind: 'center' }, rotate: { axis: 'x', angle: 270 } },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.preview).toMatch(
        /^connector\('c4', e\.endEdges\(\d+\)\.center\(\)\)\.rotate\('x', 270\)$/,
      );
      expect(result.alternatives.some(a =>
        /e\.endEdges\(edge\(\)\.line\(63\.304\d+\)/.test(a) && a.endsWith('.center()'))).toBe(true);
    }
  });

  it("suggestion refuses geometry outside a part()", () => {
    sketch("xy", () => {
        testRect(100, 50);
      });
    const e = extrude(30);
    setLocation(e, 3);
    const scene = render();
    const solid = findSolid(scene);
    const tops = faceRefsWhere(solid, m => Math.abs(m.z - 30) < 1e-6);

    const suggestion = suggestConnectorAnchors(scene, tops[0]);
    expect(suggestion.ok).toBe(false);
    if (suggestion.ok === false) {
      expect(suggestion.reason).toContain('part()');
    }
  });
});
