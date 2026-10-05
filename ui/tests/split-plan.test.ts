import { describe, it, expect } from 'vitest';
import {
  buildSplitPlan, splitPointOn, splitRefusalFor, splitSnapPoints, splitTargetOn,
} from '../src/interactive/tools/split-plan';
import type { SolvedPick } from '../src/interactive/sketch-hover-select-handler';
import type {
  SolvedConstraintView, SolvedEntityView, SolvedSketchModel,
} from '../src/sketch-solver-client/model';

// The Split tool's client-side plan: what a pick must be to split, the
// solved geometry that goes on the wire, and where each whole-line
// constraint touches the line (its hint locus).

type V2 = [number, number];

const loc = (line: number) => ({ filePath: '/w/p.fluid.js', line, column: 3 });

function lineView(entityId: number, line: number, start: V2, end: V2): SolvedEntityView {
  return { entityId, kind: 'line', start, end, obj: { sourceLocation: loc(line) } } as unknown as SolvedEntityView;
}

function pointView(entityId: number, line: number, point: V2): SolvedEntityView {
  return { entityId, kind: 'point', point, obj: { sourceLocation: loc(line) } } as unknown as SolvedEntityView;
}

function circleView(entityId: number, line: number, center: V2, radius: number): SolvedEntityView {
  return { entityId, kind: 'circle', center, radius, obj: { sourceLocation: loc(line) } } as unknown as SolvedEntityView;
}

function constraint(line: number, spec: Record<string, unknown>): SolvedConstraintView {
  return { kind: spec.kind, spec, obj: { sourceLocation: loc(line) }, status: 'ok' } as unknown as SolvedConstraintView;
}

function makeModel(entities: SolvedEntityView[], constraints: SolvedConstraintView[] = []): SolvedSketchModel {
  return {
    entities: new Map(entities.map(e => [e.entityId, e])),
    constraints,
    hasDatums: true,
  } as unknown as SolvedSketchModel;
}

function edgePick(view: SolvedEntityView, at: V2, extra: Partial<SolvedPick> = {}): SolvedPick {
  return {
    entityId: view.entityId,
    kind: view.kind,
    sourceLocation: (view.obj as { sourceLocation: SolvedPick['sourceLocation'] }).sourceLocation,
    shapeId: `s${view.entityId}`,
    at,
    ...extra,
  };
}

describe('splitRefusalFor', () => {
  const l = lineView(1, 5, [0, 0], [40, 0]);

  it('accepts a plain edge click', () => {
    expect(splitRefusalFor(edgePick(l, [10, 1]))).toBeNull();
  });

  it('names why a pick cannot split', () => {
    expect(splitRefusalFor({ entityId: -2, kind: 'line', datum: 'x-axis' })).toMatch(/axes/);
    expect(splitRefusalFor({ ...edgePick(l, [10, 1]), role: 'end' })).toMatch(/not one of its points/);
    expect(splitRefusalFor(edgePick(l, [10, 1], { reference: { refIndex: null, producer: 'project' } }))).toMatch(/projected/);
    expect(splitRefusalFor(edgePick(l, [10, 1], { copyInstance: { slot: 1 } }))).toMatch(/copy/);
    expect(splitRefusalFor(edgePick(l, [10, 1], { mirrorInstance: { source: edgePick(l, [10, 1]) } }))).toMatch(/mirror/);
    expect(splitRefusalFor(edgePick(l, [10, 1], { anchor: { owner: 'text', pointIndex: 0 } }))).toMatch(/Text/);
    expect(splitRefusalFor(edgePick(l, [10, 1], { anchor: { owner: 'bezier', pointIndex: 1 } }))).toMatch(/Bezier/);
    expect(splitRefusalFor({ ...edgePick(l, [10, 1]), kind: 'ellipse' })).toMatch(/yet/);
    expect(splitRefusalFor({ ...edgePick(l, [10, 1]), kind: 'point' })).toMatch(/point/);
    expect(splitRefusalFor({ ...edgePick(l, [10, 1]), sourceLocation: { ...loc(5), occurrence: 1 } })).toMatch(/loop/);
    expect(splitRefusalFor({ ...edgePick(l, [10, 1]), at: undefined })).toMatch(/where/);
  });
});

describe('buildSplitPlan', () => {
  it('sends the solved geometry and the click projected onto the edge, not the literals', () => {
    const l = lineView(1, 5, [0, 0], [40, 0]);
    const plan = buildSplitPlan(edgePick(l, [10, 1]), makeModel([l]));
    expect(plan).toEqual({
      ok: true,
      request: { line: 5, entity: { kind: 'line', start: [0, 0], end: [40, 0] }, at: [10, 0], hints: [] },
    });
  });

  it('describes an arc with its sweep side and a circle with its radius', () => {
    const a = { entityId: 2, kind: 'arc', start: [10, 0], end: [0, 10], center: [0, 0], radius: 10, cw: true, obj: { sourceLocation: loc(6) } } as unknown as SolvedEntityView;
    const c = circleView(3, 7, [5, 5], 4);
    const arcPlan = buildSplitPlan(edgePick(a, [7, 7]), makeModel([a]));
    const circlePlan = buildSplitPlan(edgePick(c, [9, 5]), makeModel([c]));
    expect(arcPlan.ok && arcPlan.request.entity).toEqual({ kind: 'arc', start: [10, 0], end: [0, 10], center: [0, 0], cw: true });
    expect(circlePlan.ok && circlePlan.request.entity).toEqual({ kind: 'circle', center: [5, 5], radius: 4 });
    expect(circlePlan.ok && circlePlan.request.hints).toEqual([]);
  });

  it('hints where each whole-line constraint touches the line', () => {
    const l = lineView(1, 5, [0, 0], [40, 0]);
    const p = pointView(2, 6, [30, 0]);
    const c = circleView(3, 7, [10, 5], 5);
    const other = lineView(4, 8, [0, 10], [20, 10]);
    const model = makeModel([l, p, c, other], [
      constraint(10, { kind: 'coincident', a: { entity: 2 }, b: { entity: 1 } }),
      constraint(11, { kind: 'tangent', a: { entity: 1 }, b: { entity: 3 } }),
      constraint(12, { kind: 'distance', a: { entity: 1 }, b: { entity: 4 }, value: 10 }),
      constraint(13, { kind: 'horizontal', a: { entity: 1 } }),
      constraint(14, { kind: 'coincident', a: { entity: 1, point: 'end' }, b: { entity: 4, point: 'start' } }),
    ]);
    const plan = buildSplitPlan(edgePick(l, [10, 1]), model);
    expect(plan.ok && plan.request.hints).toEqual([
      { line: 10, locus: [30, 0] },
      { line: 11, locus: [10, 0] },
      { line: 12, locus: [10, 0] },
    ]);
  });

  it('refuses a line whose geometry the render did not carry', () => {
    const bare = { entityId: 1, kind: 'line', obj: { sourceLocation: loc(5) } } as unknown as SolvedEntityView;
    const plan = buildSplitPlan(edgePick(bare, [10, 1]), makeModel([bare]));
    expect(plan.ok).toBe(false);
  });

  it('lands the cut on the snap mark the hover marker showed', () => {
    const l = lineView(1, 5, [0, 0], [40, 0]);
    const snapped = buildSplitPlan(edgePick(l, [18, 2]), makeModel([l]), 3);
    expect(snapped.ok && snapped.request.at).toEqual([20, 0]);
    const free = buildSplitPlan(edgePick(l, [18, 2]), makeModel([l]), 1);
    expect(free.ok && free.request.at).toEqual([18, 0]);
    const exact = buildSplitPlan(edgePick(l, [18, 2]), makeModel([l]));
    expect(exact.ok && exact.request.at).toEqual([18, 0]);
  });
});

describe('splitSnapPoints', () => {
  it('marks a line midpoint, an arc midpoint on its drawn side and a circle quarter marks', () => {
    expect(splitSnapPoints(lineView(1, 5, [0, 0], [40, 10]))).toEqual([[20, 5]]);
    const cw = { entityId: 2, kind: 'arc', start: [10, 0], end: [0, 10], center: [0, 0], radius: 10, cw: true, obj: { sourceLocation: loc(6) } } as unknown as SolvedEntityView;
    const [cwMid] = splitSnapPoints(cw);
    expect(cwMid[0]).toBeCloseTo(-Math.SQRT1_2 * 10);
    expect(cwMid[1]).toBeCloseTo(-Math.SQRT1_2 * 10);
    const ccw = { ...cw, cw: false } as SolvedEntityView;
    const [ccwMid] = splitSnapPoints(ccw);
    expect(ccwMid[0]).toBeCloseTo(Math.SQRT1_2 * 10);
    expect(ccwMid[1]).toBeCloseTo(Math.SQRT1_2 * 10);
    expect(splitSnapPoints(circleView(3, 7, [5, 5], 4))).toEqual([[9, 5], [5, 9], [1, 5], [5, 1]]);
    expect(splitSnapPoints(pointView(4, 8, [1, 1]))).toEqual([]);
    expect(splitSnapPoints({ entityId: 9, kind: 'ellipse' } as unknown as SolvedEntityView)).toEqual([]);
  });
});

describe('splitTargetOn', () => {
  it('snaps within the tolerance and slides freely outside it', () => {
    const l = lineView(1, 5, [0, 0], [40, 0]);
    expect(splitTargetOn(l, [18, 3], 3)).toEqual({ at: [20, 0], snapped: true });
    expect(splitTargetOn(l, [18, 3], 1)).toEqual({ at: [18, 0], snapped: false });
    expect(splitTargetOn(l, [-5, 3], 3)).toEqual({ at: [0, 0], snapped: false });
  });

  it('measures the reach along the edge from the free cut point, not from the cursor', () => {
    // The cursor sits 10 off the line but its foot is right on the midpoint.
    const l = lineView(1, 5, [0, 0], [40, 0]);
    expect(splitTargetOn(l, [20, 10], 1)).toEqual({ at: [20, 0], snapped: true });
  });

  it('picks the nearest quarter mark of a circle', () => {
    const c = circleView(3, 7, [0, 0], 10);
    expect(splitTargetOn(c, [1, 30], 2)).toEqual({ at: [0, 10], snapped: true });
    expect(splitTargetOn(c, [-30, -1], 2)).toEqual({ at: [-10, 0], snapped: true });
    const between = splitTargetOn(c, [10, 10], 2)!;
    expect(between.snapped).toBe(false);
    expect(between.at[0]).toBeCloseTo(Math.SQRT1_2 * 10);
  });

  it('refuses what splitPointOn refuses', () => {
    expect(splitTargetOn({ entityId: 9, kind: 'ellipse' } as unknown as SolvedEntityView, [1, 1], 3)).toBeNull();
  });
});

describe('splitPointOn', () => {
  it('clamps the foot to the line segment and lands on the circumference of round entities', () => {
    const l = lineView(1, 5, [0, 0], [40, 0]);
    expect(splitPointOn(l, [10, 3])).toEqual([10, 0]);
    expect(splitPointOn(l, [-5, 3])).toEqual([0, 0]);
    expect(splitPointOn(l, [50, -2])).toEqual([40, 0]);
    const c = circleView(3, 7, [0, 0], 10);
    const on = splitPointOn(c, [0, 25])!;
    expect(on[0]).toBeCloseTo(0);
    expect(on[1]).toBeCloseTo(10);
    const a = { entityId: 2, kind: 'arc', start: [10, 0], end: [0, 10], center: [0, 0], radius: 10, cw: false, obj: { sourceLocation: loc(6) } } as unknown as SolvedEntityView;
    const onArc = splitPointOn(a, [3, 3])!;
    expect(onArc[0]).toBeCloseTo(Math.SQRT1_2 * 10);
    expect(onArc[1]).toBeCloseTo(Math.SQRT1_2 * 10);
    expect(splitPointOn({ entityId: 9, kind: 'ellipse' } as unknown as SolvedEntityView, [1, 1])).toBeNull();
  });
});
