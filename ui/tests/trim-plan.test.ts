import { describe, it, expect } from 'vitest';
import { buildTrimPlan, trimRefusalFor, trimSegmentOn } from '../src/interactive/tools/trim-plan';
import type { SolvedPick } from '../src/interactive/sketch-hover-select-handler';
import type {
  SolvedConstraintView, SolvedEntityView, SolvedSketchModel,
} from '../src/sketch-solver-client/model';

// The Trim tool's client-side plan: the stretch of an edge a click removes
// (between the nearest crossings), the piece index the kernel's cut yields
// for it, and the request that goes on the wire.

type V2 = [number, number];

const loc = (line: number) => ({ filePath: '/w/p.fluid.js', line, column: 3 });

const near = (a: V2, b: V2, tol = 1e-6): void => {
  expect(Math.abs(a[0] - b[0])).toBeLessThan(tol);
  expect(Math.abs(a[1] - b[1])).toBeLessThan(tol);
};

function lineView(entityId: number, line: number, start: V2, end: V2): SolvedEntityView {
  return { entityId, kind: 'line', start, end, obj: { sourceLocation: loc(line) } } as unknown as SolvedEntityView;
}

function circleView(entityId: number, line: number, center: V2, radius: number): SolvedEntityView {
  return { entityId, kind: 'circle', center, radius, obj: { sourceLocation: loc(line) } } as unknown as SolvedEntityView;
}

function arcView(entityId: number, line: number, start: V2, end: V2, center: V2, cw: boolean): SolvedEntityView {
  const radius = Math.hypot(start[0] - center[0], start[1] - center[1]);
  return { entityId, kind: 'arc', start, end, center, radius, cw, obj: { sourceLocation: loc(line) } } as unknown as SolvedEntityView;
}

function pointView(entityId: number, line: number, point: V2): SolvedEntityView {
  return { entityId, kind: 'point', point, obj: { sourceLocation: loc(line) } } as unknown as SolvedEntityView;
}

function constraint(line: number, spec: Record<string, unknown>): SolvedConstraintView {
  return { kind: spec.kind, spec, obj: { sourceLocation: loc(line) }, status: 'ok' } as unknown as SolvedConstraintView;
}

function makeModel(entities: SolvedEntityView[], constraints: SolvedConstraintView[] = []): SolvedSketchModel {
  return {
    entities: new Map(entities.map(e => [e.entityId, e])),
    beziers: new Map(),
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

/** A 40-long line crossed by verticals at 10 and 30. */
function crossedLine(): { l: SolvedEntityView; model: SolvedSketchModel } {
  const l = lineView(1, 5, [0, 0], [40, 0]);
  const model = makeModel([l, lineView(2, 6, [10, -5], [10, 5]), lineView(3, 7, [30, -5], [30, 5])]);
  return { l, model };
}

describe('trimRefusalFor', () => {
  it('accepts a plain edge click and names why a pick cannot be trimmed', () => {
    const l = lineView(1, 5, [0, 0], [40, 0]);
    expect(trimRefusalFor(edgePick(l, [10, 1]))).toBeNull();
    expect(trimRefusalFor({ entityId: -2, kind: 'line', datum: 'x-axis' })).toMatch(/can't be trimmed/);
    expect(trimRefusalFor(edgePick(l, [10, 1], { copyInstance: { slot: 1 } }))).toMatch(/trim its source edge/);
    expect(trimRefusalFor({ ...edgePick(l, [10, 1]), at: undefined })).toMatch(/part of the edge/);
  });
});

describe('trimSegmentOn', () => {
  it('bounds the segment by the nearest crossings on either side of the click', () => {
    const { l, model } = crossedLine();
    const middle = trimSegmentOn(l, model, [20, 2])!;
    expect(middle.whole).toBe(false);
    expect(middle.removed).toBe(1);
    expect(middle.cuts).toEqual([[10, 0], [30, 0]]);
    expect(middle.points).toEqual([[10, 0], [30, 0]]);

    const startSide = trimSegmentOn(l, model, [3, -1])!;
    expect(startSide.removed).toBe(0);
    expect(startSide.cuts).toEqual([[10, 0]]);
    expect(startSide.points).toEqual([[0, 0], [10, 0]]);

    const endSide = trimSegmentOn(l, model, [38, 1])!;
    expect(endSide.removed).toBe(1);
    expect(endSide.cuts).toEqual([[30, 0]]);
    expect(endSide.points).toEqual([[30, 0], [40, 0]]);
  });

  it('takes the whole edge when nothing crosses it — corners are not crossings', () => {
    const bottom = lineView(1, 5, [0, 0], [40, 0]);
    const model = makeModel([bottom, lineView(2, 6, [0, 0], [0, 20]), lineView(3, 7, [40, 0], [40, 20])]);
    const whole = trimSegmentOn(bottom, model, [20, 1])!;
    expect(whole.whole).toBe(true);
    expect(whole.cuts).toEqual([]);
    expect(whole.removed).toBe(0);
    expect(whole.points).toEqual([[0, 0], [40, 0]]);
  });

  it('measures an arc along its sweep, clockwise too', () => {
    // Clockwise from (10,0) to (0,10), the long way round through the
    // bottom; the y axis line crosses it at (0,-10) and the x axis line at
    // (-10,0). A click at the bottom-left, between them, removes that quarter.
    const a = arcView(1, 5, [10, 0], [0, 10], [0, 0], true);
    const model = makeModel([a, lineView(2, 6, [0, -20], [0, 20]), lineView(3, 7, [-20, 0], [20, 0])]);
    const quarter = trimSegmentOn(a, model, [-7, -7])!;
    expect(quarter.removed).toBe(1);
    expect(quarter.cuts).toHaveLength(2);
    near(quarter.cuts[0], [0, -10]);
    near(quarter.cuts[1], [-10, 0]);
    near(quarter.points[0], [0, -10]);
    near(quarter.points[quarter.points.length - 1], [-10, 0]);
    // A click near the start (the first quarter, top-right to bottom).
    const first = trimSegmentOn(a, model, [7, -7])!;
    expect(first.removed).toBe(0);
    expect(first.cuts).toHaveLength(1);
    near(first.cuts[0], [0, -10]);
    // A click just beyond the start, on the circle but off the drawn side,
    // clamps to the start and still takes the first quarter.
    const beyond = trimSegmentOn(a, model, [10, 0.5])!;
    expect(beyond.removed).toBe(0);
    near(beyond.cuts[0], [0, -10]);
    near(beyond.points[0], [10, 0]);
  });

  it('bounds a circle\'s segment counter-clockwise from the crossing before the click', () => {
    const c = circleView(1, 5, [0, 0], 10);
    const model = makeModel([c, lineView(2, 6, [-20, 0], [20, 0])]);
    const top = trimSegmentOn(c, model, [1, 12])!;
    expect(top.removed).toBe(0);
    expect(top.whole).toBe(false);
    near(top.cuts[0], [10, 0]);
    near(top.cuts[1], [-10, 0]);
    near(top.points[0], [10, 0]);
    near(top.points[top.points.length - 1], [-10, 0]);
    expect(top.points.every(p => p[1] > -1e-9)).toBe(true);
    const bottom = trimSegmentOn(c, model, [-1, -12])!;
    near(bottom.cuts[0], [-10, 0]);
    near(bottom.cuts[1], [10, 0]);
  });

  it('takes the whole circle when fewer than two things cross it', () => {
    const c = circleView(1, 5, [0, 0], 10);
    const tangent = makeModel([c, lineView(2, 6, [-20, 10], [20, 10])]);
    const whole = trimSegmentOn(c, tangent, [12, 1])!;
    expect(whole.whole).toBe(true);
    expect(whole.cuts).toEqual([]);
    expect(whole.points.length).toBeGreaterThan(10);
  });

  it('refuses what it cannot trim', () => {
    expect(trimSegmentOn({ entityId: 9, kind: 'ellipse' } as unknown as SolvedEntityView, makeModel([]), [1, 1])).toBeNull();
  });
});

describe('buildTrimPlan', () => {
  it('sends the solved geometry, the cuts, the piece index and every constraint hint', () => {
    const { l, model } = crossedLine();
    const p = pointView(4, 8, [35, 0]);
    const q = pointView(5, 9, [20, 7]);
    const withConstraints = makeModel([...model.entities.values(), p, q], [
      constraint(10, { kind: 'coincident', a: { entity: 4 }, b: { entity: 1 } }),
      constraint(11, { kind: 'distance', a: { entity: 1 }, b: { entity: 5 }, value: 7 }),
      constraint(12, { kind: 'horizontal', a: { entity: 1 } }),
    ]);
    const plan = buildTrimPlan(edgePick(l, [20, 2]), withConstraints);
    expect(plan).toEqual({
      ok: true,
      request: {
        line: 5,
        entity: { kind: 'line', start: [0, 0], end: [40, 0] },
        cuts: [[10, 0], [30, 0]],
        cutters: [{ line: 6, featureType: 'line' }, { line: 7, featureType: 'line' }],
        removed: 1,
        hints: [{ line: 10, locus: [35, 0] }, { line: 11, locus: [20, 0] }],
      },
    });
  });

  it('names the end of a cutting edge the cut sits on, and nothing for a bezier or a looped edge', () => {
    const l = lineView(1, 5, [0, 0], [40, 0]);
    const tee = lineView(2, 6, [10, 0], [10, 9]);
    const looped = { ...lineView(3, 7, [30, -5], [30, 5]), obj: { sourceLocation: { ...loc(7), occurrence: 2 } } } as SolvedEntityView;
    const plan = buildTrimPlan(edgePick(l, [20, 1]), makeModel([l, tee, looped]));
    expect(plan.ok && plan.request.cutters).toEqual([{ line: 6, featureType: 'line', role: 'start' }, null]);
  });

  it('hints where a constraint touches a round entity too', () => {
    const c = circleView(1, 5, [0, 0], 10);
    const p = pointView(2, 6, [0, 10]);
    const model = makeModel([c, p, lineView(3, 7, [-20, 0], [20, 0])], [
      constraint(10, { kind: 'coincident', a: { entity: 2 }, b: { entity: 1 } }),
    ]);
    const plan = buildTrimPlan(edgePick(c, [1, 12]), model);
    expect(plan.ok && plan.request.hints).toEqual([{ line: 10, locus: [0, 10] }]);
  });

  it('refuses a pick it cannot trim and a line whose geometry the render did not carry', () => {
    const l = lineView(1, 5, [0, 0], [40, 0]);
    expect(buildTrimPlan({ ...edgePick(l, [10, 1]), role: 'end' }, makeModel([l])).ok).toBe(false);
    const bare = { entityId: 1, kind: 'line', obj: { sourceLocation: loc(5) } } as unknown as SolvedEntityView;
    expect(buildTrimPlan(edgePick(bare, [10, 1]), makeModel([bare])).ok).toBe(false);
  });
});
