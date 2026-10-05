// The sketcher's constrained Offset plan: OCCT offsets the picked chain with
// sharp corners and every result edge comes back as the primitive the tool
// writes, mapped to its source, with each junction classified — a corner
// (the rails cross; a coincident joins them) or a tangent junction (the
// sources are tangent there, so the offsets meet on their own).
import { describe, it, expect } from "vitest";
import { setupOC, render } from "./setup.js";
import sketch from "../core/sketch.js";
import { arc, bezier, circle, line } from "../core/2d/index.js";
import { coincident, tangent } from "../core/constraints/index.js";
import { Sketch } from "../features/2d/sketch.js";
import { DEFAULT_MESH_CONFIG } from "../oc/mesh.js";
import { planSketchOffset, type OffsetPlanChain, type OffsetPlanEdge } from "../rendering/offset-plan.js";

/** The sketch's edges in statement order (one edge per primitive statement). */
function edgeIds(s: Sketch): string[] {
  return [...s.getEdgesWithOwner().keys()].map(e => e.id);
}

/**
 * Render once, then plan over the sketch's built edges at any distance —
 * a second render would rebuild the scene under the edges already read.
 */
function planner(s: Sketch) {
  const scene = render();
  const entities = edgeIds(s).map(shapeId => ({ shapeId }));
  return (distance: number, close = false) =>
    planSketchOffset(scene, { entities, distance, close }, DEFAULT_MESH_CONFIG);
}

function chainOf(result: ReturnType<typeof planSketchOffset>, index = 0): OffsetPlanChain {
  if ('reason' in result) {
    throw new Error(`plan refused: ${result.reason}`);
  }
  return result.chains[index];
}

function refusal(result: ReturnType<typeof planSketchOffset>): string {
  return 'reason' in result ? result.reason : '';
}

function endpoints(e: OffsetPlanEdge): [number, number][] {
  return e.kind === 'circle' ? [] : [e.start, e.end];
}

const near = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6;

describe("planSketchOffset", () => {
  setupOC();

  it("closed square, outward: four lines, four corners, sources mapped, corners at the rail crossings", () => {
    const s = sketch('xy', () => {
      const a = line([0, 0], [40, 0]);
      const b = line([40, 0], [40, 30]);
      const c = line([40, 30], [0, 30]);
      const d = line([0, 30], [0, 0]);
      coincident(a.end(), b.start());
      coincident(b.end(), c.start());
      coincident(c.end(), d.start());
      coincident(d.end(), a.start());
    }) as unknown as Sketch;
    const chain = chainOf(planner(s)(3));
    expect(chain.closed).toBe(true);
    expect(chain.edges).toHaveLength(4);
    expect(chain.edges.map(e => e.kind)).toEqual(['line', 'line', 'line', 'line']);
    expect([...chain.edges.map(e => e.source)].sort()).toEqual([0, 1, 2, 3]);
    expect(chain.edges.map(e => e.joinNext)).toEqual(['corner', 'corner', 'corner', 'corner']);
    // Consecutive edges meet; every corner is one of the four outer corners.
    const corners: [number, number][] = [[-3, -3], [43, -3], [43, 33], [-3, 33]];
    for (let i = 0; i < 4; i++) {
      const here = chain.edges[i];
      const next = chain.edges[(i + 1) % 4];
      expect(near(endpoints(here)[1], endpoints(next)[0])).toBe(true);
      expect(corners.some(c => near(c, endpoints(here)[1]))).toBe(true);
    }
    // The bottom line (source 0) runs along y = −3 in the source's direction.
    const bottom = chain.edges.find(e => e.source === 0)!;
    expect(bottom.kind === 'line' && bottom.start[1]).toBeCloseTo(-3, 6);
    expect(bottom.kind === 'line' && bottom.start[0] < bottom.end[0]).toBe(true);
  });

  it("closed square, inward: the smaller square", () => {
    const s = sketch('xy', () => {
      const a = line([0, 0], [40, 0]);
      const b = line([40, 0], [40, 30]);
      const c = line([40, 30], [0, 30]);
      const d = line([0, 30], [0, 0]);
      coincident(a.end(), b.start());
      coincident(b.end(), c.start());
      coincident(c.end(), d.start());
      coincident(d.end(), a.start());
    }) as unknown as Sketch;
    const chain = chainOf(planner(s)(-3));
    const bottom = chain.edges.find(e => e.source === 0)!;
    expect(bottom.kind === 'line' && bottom.start).toEqual([expect.closeTo(3, 6), expect.closeTo(3, 6)]);
    expect(bottom.kind === 'line' && bottom.end).toEqual([expect.closeTo(37, 6), expect.closeTo(3, 6)]);
  });

  it("open polyline: square ends at the perpendicular feet, corners between, caps on request", () => {
    const s = sketch('xy', () => {
      const a = line([0, 0], [40, 0]);
      const b = line([40, 0], [40, 30]);
      const c = line([40, 30], [10, 30]);
      coincident(a.end(), b.start());
      coincident(b.end(), c.start());
    }) as unknown as Sketch;
    const plan = planner(s);
    const chain = chainOf(plan(-3, true));
    expect(chain.closed).toBe(false);
    expect(chain.edges.map(e => [e.source, e.joinNext])).toEqual([[0, 'corner'], [1, 'corner'], [2, null]]);
    const [first, mid, last] = chain.edges as Extract<OffsetPlanEdge, { kind: 'line' }>[];
    expect(first.start).toEqual([expect.closeTo(0, 6), expect.closeTo(-3, 6)]);
    expect(first.end).toEqual([expect.closeTo(43, 6), expect.closeTo(-3, 6)]);
    expect(mid.end).toEqual([expect.closeTo(43, 6), expect.closeTo(33, 6)]);
    expect(last.end).toEqual([expect.closeTo(10, 6), expect.closeTo(33, 6)]);
    expect(chain.caps).toEqual([
      { start: [expect.closeTo(10, 6), expect.closeTo(30, 6)], end: [expect.closeTo(10, 6), expect.closeTo(33, 6)] },
      { start: [expect.closeTo(0, 6), expect.closeTo(-3, 6)], end: [expect.closeTo(0, 6), expect.closeTo(0, 6)] },
    ]);
    // The other side.
    const above = chainOf(plan(3));
    const top = above.edges[0] as Extract<OffsetPlanEdge, { kind: 'line' }>;
    expect(top.start).toEqual([expect.closeTo(0, 6), expect.closeTo(3, 6)]);
    expect(top.end).toEqual([expect.closeTo(37, 6), expect.closeTo(3, 6)]);
    expect(above.caps).toBeUndefined();
  });

  it("rounded rectangle: arcs stay arcs, every junction is tangent", () => {
    const s = sketch('xy', () => {
      const b = line([5, 0], [35, 0]);
      const c1 = arc([35, 0], [40, 5], [35, 5]);
      const rt = line([40, 5], [40, 25]);
      const c2 = arc([40, 25], [35, 30], [35, 25]);
      const t = line([35, 30], [5, 30]);
      const c3 = arc([5, 30], [0, 25], [5, 25]);
      const lf = line([0, 25], [0, 5]);
      const c4 = arc([0, 5], [5, 0], [5, 5]);
      const lines = [b, rt, t, lf];
      const arcs = [c1, c2, c3, c4];
      for (let i = 0; i < 4; i++) {
        coincident(lines[i].end(), arcs[i].start());
        coincident(arcs[i].end(), lines[(i + 1) % 4].start());
        tangent(lines[i], arcs[i]);
        tangent(arcs[i], lines[(i + 1) % 4]);
      }
    }) as unknown as Sketch;
    const plan = planner(s);
    const outer = chainOf(plan(3));
    expect(outer.closed).toBe(true);
    expect(outer.edges).toHaveLength(8);
    expect(outer.edges.every(e => e.joinNext === 'tangent')).toBe(true);
    const arcsOut = outer.edges.filter((e): e is Extract<OffsetPlanEdge, { kind: 'arc' }> => e.kind === 'arc');
    expect(arcsOut).toHaveLength(4);
    for (const a of arcsOut) {
      expect(a.radius).toBeCloseTo(8, 6);
      expect(a.cw).toBe(false);
    }
    const c1 = arcsOut.find(a => a.source === 1)!;
    expect(c1.center).toEqual([expect.closeTo(35, 6), expect.closeTo(5, 6)]);
    expect(c1.start).toEqual([expect.closeTo(35, 6), expect.closeTo(-3, 6)]);
    expect(c1.end).toEqual([expect.closeTo(43, 6), expect.closeTo(5, 6)]);
    const inner = chainOf(plan(-2));
    const arcsIn = inner.edges.filter((e): e is Extract<OffsetPlanEdge, { kind: 'arc' }> => e.kind === 'arc');
    for (const a of arcsIn) {
      expect(a.radius).toBeCloseTo(3, 6);
    }
  });

  it("a clockwise-drawn closed profile still reads the sign as outward/inward", () => {
    const s = sketch('xy', () => {
      const a = line([0, 0], [0, 30]);
      const b = line([0, 30], [40, 30]);
      const c = line([40, 30], [40, 0]);
      const d = line([40, 0], [0, 0]);
      coincident(a.end(), b.start());
      coincident(b.end(), c.start());
      coincident(c.end(), d.start());
      coincident(d.end(), a.start());
    }) as unknown as Sketch;
    const chain = chainOf(planner(s)(3));
    const left = chain.edges.find(e => e.source === 0) as Extract<OffsetPlanEdge, { kind: 'line' }>;
    expect(left.start[0]).toBeCloseTo(-3, 6);
    expect(left.end[0]).toBeCloseTo(-3, 6);
  });

  it("circle: a concentric circle", () => {
    const s = sketch('xy', () => {
      circle([10, 10], 20);
    }) as unknown as Sketch;
    const plan = planner(s);
    const chain = chainOf(plan(2.5));
    expect(chain.edges).toEqual([{ kind: 'circle', source: 0, center: [expect.closeTo(10, 6), expect.closeTo(10, 6)], radius: expect.closeTo(12.5, 6), joinNext: null }]);
    const inner = chainOf(plan(-2.5));
    expect(inner.edges[0].kind === 'circle' && inner.edges[0].radius).toBeCloseTo(7.5, 6);
  });

  it("two separate picks form two chains, each a single line with square ends", () => {
    const s = sketch('xy', () => {
      line([0, 0], [40, 0]);
      line([0, 20], [40, 20]);
    }) as unknown as Sketch;
    const result = planner(s)(3);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.chains).toHaveLength(2);
    for (const chain of result.chains) {
      expect(chain.edges).toHaveLength(1);
      expect(chain.edges[0].joinNext).toBeNull();
    }
    expect(result.meshes).toHaveLength(2);
  });

  it("refuses curves the sketch cannot hold and an inward distance that swallows an edge", () => {
    const s = sketch('xy', () => {
      bezier([0, 0], [10, 20], [30, -10], [40, 0]);
    }) as unknown as Sketch;
    const curve = planner(s)(3);
    expect(refusal(curve)).toMatch(/not a line, arc or circle/);

    const r = sketch('xy', () => {
      const a = line([0, 0], [40, 0]);
      const b = line([40, 0], [40, 30]);
      const c = line([40, 30], [0, 30]);
      const d = line([0, 30], [0, 0]);
      coincident(a.end(), b.start());
      coincident(b.end(), c.start());
      coincident(c.end(), d.start());
      coincident(d.end(), a.start());
    }) as unknown as Sketch;
    const swallowed = planner(r)(-16);
    expect(swallowed.ok).toBe(false);
  });
});
