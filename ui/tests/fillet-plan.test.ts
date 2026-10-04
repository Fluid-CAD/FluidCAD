import { describe, it, expect } from 'vitest';
import { buildFilletPlan } from '../src/interactive/tools/fillet-plan';
import type { SolvedPick } from '../src/interactive/sketch-hover-select-handler';
import type { SolvedEntityView, SolvedSketchModel } from '../src/sketch-solver-client/model';

// Constraint-native fillet (P8): the corner math. The plan names each corner
// by its two edge ends (the arc starts on `a`, ends on `b`) and carries the
// corner and the arc — the server's transform (SketchFillet) writes the
// recipe, the trimmed edges and the virtual sharps from it.

type V2 = [number, number];

function lineView(entityId: number, line: number, start: V2, end: V2): SolvedEntityView {
  return {
    entityId, kind: 'line', start, end,
    obj: { sourceLocation: { filePath: '/w/p.fluid.js', line, column: 3 } },
  } as unknown as SolvedEntityView;
}

function arcView(
  entityId: number, line: number, start: V2, end: V2, center: V2, radius: number, cw = false,
): SolvedEntityView {
  return {
    entityId, kind: 'arc', start, end, center, radius, cw,
    obj: { sourceLocation: { filePath: '/w/p.fluid.js', line, column: 3 } },
  } as unknown as SolvedEntityView;
}

function makeModel(entities: SolvedEntityView[]): SolvedSketchModel {
  return {
    entities: new Map(entities.map(e => [e.entityId, e])),
    constraints: [],
  } as unknown as SolvedSketchModel;
}

function edgePick(view: SolvedEntityView): SolvedPick {
  return {
    entityId: view.entityId,
    kind: view.kind as 'line' | 'arc',
    sourceLocation: (view.obj as { sourceLocation: SolvedPick['sourceLocation'] }).sourceLocation,
  };
}

const near = (a: V2, b: V2, tol = 0.05): void => {
  expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeLessThan(tol);
};

describe('buildFilletPlan — line-line corners', () => {
  const l1 = lineView(0, 5, [0, 0], [100, 0]);
  const l2 = lineView(1, 6, [100, 0], [100, 50]);

  it('plans a right-angle corner: its two edge ends, the corner and the arc', () => {
    const plan = buildFilletPlan({
      picks: [edgePick(l1), edgePick(l2)], model: makeModel([l1, l2]), radius: 4, radiusExpr: '4',
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) {
      return;
    }
    expect(plan.corners).toBe(1);
    expect(plan.request.radiusExpr).toBe('4');
    expect(plan.request.corners).toHaveLength(1);
    const [corner] = plan.request.corners;
    expect(corner.a).toEqual({ line: 5, featureType: 'line', role: 'end' });
    expect(corner.b).toEqual({ line: 6, featureType: 'line', role: 'start' });
    near(corner.at, [100, 0]);
    near(corner.start, [96, 0]);
    near(corner.end, [100, 4]);
    near(corner.center, [96, 4]);
    expect(corner.cw).toBe(false);
  });

  it('sweeps clockwise when the corner turns the other way', () => {
    const down = lineView(1, 6, [100, 0], [100, -50]);
    const model = makeModel([l1, down]);
    const plan = buildFilletPlan({
      picks: [edgePick(l1), edgePick(down)], model, radius: 4, radiusExpr: '4',
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) {
      return;
    }
    const [corner] = plan.request.corners;
    near(corner.start, [96, 0]);
    near(corner.end, [100, -4]);
    near(corner.center, [96, -4]);
    expect(corner.cw).toBe(true);
  });

  it('plans every corner of a multi-corner chain, the radius expression verbatim', () => {
    const l3 = lineView(2, 7, [100, 50], [0, 50]);
    const plan = buildFilletPlan({
      picks: [edgePick(l1), edgePick(l2), edgePick(l3)], model: makeModel([l1, l2, l3]), radius: 5, radiusExpr: 'r',
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) {
      return;
    }
    expect(plan.corners).toBe(2);
    expect(plan.request.radiusExpr).toBe('r');
    expect(plan.request.corners.map(c => [c.a, c.b])).toEqual([
      [{ line: 5, featureType: 'line', role: 'end' }, { line: 6, featureType: 'line', role: 'start' }],
      [{ line: 6, featureType: 'line', role: 'end' }, { line: 7, featureType: 'line', role: 'start' }],
    ]);
    near(plan.request.corners[0].at, [100, 0]);
    near(plan.request.corners[1].at, [100, 50]);
  });

  it('refuses a radius that does not fit the corner', () => {
    const model = makeModel([l1, l2]);
    const plan = buildFilletPlan({
      picks: [edgePick(l1), edgePick(l2)], model, radius: 60, radiusExpr: '60',
    });
    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.reason).toContain('does not fit');
    }
  });

  it('refuses when both fillets of a short middle edge overlap', () => {
    const short = lineView(1, 6, [100, 0], [100, 8]);
    const l3 = lineView(2, 7, [100, 8], [0, 8]);
    const model = makeModel([l1, short, l3]);
    const plan = buildFilletPlan({
      picks: [edgePick(l1), edgePick(short), edgePick(l3)], model, radius: 5, radiusExpr: '5',
    });
    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.reason).toContain('too large');
    }
  });

  it('refuses edges that do not meet', () => {
    const far = lineView(1, 6, [0, 20], [100, 20]);
    const model = makeModel([l1, far]);
    const plan = buildFilletPlan({
      picks: [edgePick(l1), edgePick(far)], model, radius: 4, radiusExpr: '4',
    });
    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.reason).toContain('corner');
    }
  });

  it('refuses three edges meeting at one point', () => {
    const l2b = lineView(2, 7, [100, 0], [150, 50]);
    const model = makeModel([l1, l2, l2b]);
    const plan = buildFilletPlan({
      picks: [edgePick(l1), edgePick(l2), edgePick(l2b)], model, radius: 4, radiusExpr: '4',
    });
    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.reason).toContain('more than two');
    }
  });

  it('refuses circles, loop instances, references and copy instances', () => {
    const circle = {
      entityId: 3, kind: 'circle', center: [0, 0], radius: 5,
      obj: { sourceLocation: { filePath: '/w/p.fluid.js', line: 8, column: 3 } },
    } as unknown as SolvedEntityView;
    const model = makeModel([l1, circle]);
    const circlePick: SolvedPick = { entityId: 3, kind: 'circle', sourceLocation: { filePath: '/w/p.fluid.js', line: 8, column: 3 } };
    const asCircle = buildFilletPlan({
      picks: [edgePick(l1), circlePick], model, radius: 4, radiusExpr: '4',
    });
    expect(asCircle.ok).toBe(false);

    const looped: SolvedPick = {
      ...edgePick(l2),
      sourceLocation: { filePath: '/w/p.fluid.js', line: 6, column: 3, occurrence: 1 },
    };
    const loopedResult = buildFilletPlan({
      picks: [edgePick(l1), looped], model: makeModel([l1, l2]), radius: 4, radiusExpr: '4',
    });
    expect(loopedResult.ok).toBe(false);

    const reference: SolvedPick = { ...edgePick(l2), reference: { refIndex: 0, producer: 'project' } };
    const refResult = buildFilletPlan({
      picks: [edgePick(l1), reference], model: makeModel([l1, l2]), radius: 4, radiusExpr: '4',
    });
    expect(refResult.ok).toBe(false);

    const copy: SolvedPick = { ...edgePick(l2), copyInstance: { slot: 1 } };
    const copyResult = buildFilletPlan({
      picks: [edgePick(l1), copy], model: makeModel([l1, l2]), radius: 4, radiusExpr: '4',
    });
    expect(copyResult.ok).toBe(false);
  });

  it('needs at least two picked edges', () => {
    const plan = buildFilletPlan({
      picks: [edgePick(l1)], model: makeModel([l1]), radius: 4, radiusExpr: '4',
    });
    expect(plan.ok).toBe(false);
  });
});

describe('buildFilletPlan — arc corners', () => {
  it('fillets a line-arc corner (offset-intersection candidates)', () => {
    // Line comes in along +x; a CW arc leaves the corner going up (center
    // to the right, so the fillet sits outside the arc).
    const l1 = lineView(0, 5, [0, 0], [100, 0]);
    const a1 = arcView(1, 6, [100, 0], [150, 50], [150, 0], 50, true);
    const model = makeModel([l1, a1]);
    const plan = buildFilletPlan({
      picks: [edgePick(l1), edgePick(a1)], model, radius: 5, radiusExpr: '5',
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) {
      return;
    }
    const corner = plan.request.corners[0];
    expect(corner.a).toEqual({ line: 5, featureType: 'line', role: 'end' });
    expect(corner.b).toEqual({ line: 6, featureType: 'arc', role: 'start' });
    near(corner.at, [100, 0]);
    // Fillet center: 5 above the line, 55 from the arc's center.
    expect(Math.abs(corner.center[1] - 5)).toBeLessThan(0.05);
    expect(Math.abs(Math.hypot(corner.center[0] - 150, corner.center[1]) - 55)).toBeLessThan(0.05);
    // Tangent points: on the line (y = 0) and on the arc's circle.
    expect(Math.abs(corner.start[1])).toBeLessThan(0.05);
    expect(Math.abs(Math.hypot(corner.end[0] - 150, corner.end[1]) - 50)).toBeLessThan(0.05);
    // Both fillet ends sit at the fillet radius from its center.
    expect(Math.abs(Math.hypot(corner.start[0] - corner.center[0], corner.start[1] - corner.center[1]) - 5)).toBeLessThan(0.05);
    expect(Math.abs(Math.hypot(corner.end[0] - corner.center[0], corner.end[1] - corner.center[1]) - 5)).toBeLessThan(0.05);
  });

  it('refuses a smooth (already tangent) junction', () => {
    // The arc leaves the corner along the line's own direction — no corner.
    const l1 = lineView(0, 5, [0, 0], [100, 0]);
    const a1 = arcView(1, 6, [100, 0], [150, 50], [100, 50], 50, false);
    const model = makeModel([l1, a1]);
    const plan = buildFilletPlan({
      picks: [edgePick(l1), edgePick(a1)], model, radius: 5, radiusExpr: '5',
    });
    expect(plan.ok).toBe(false);
  });
});
