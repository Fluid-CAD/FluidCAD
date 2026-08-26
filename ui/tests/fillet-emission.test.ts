import { describe, it, expect } from 'vitest';
import { buildFilletEmission } from '../src/interactive/tools/fillet-emission';
import type { SolvedPick } from '../src/interactive/sketch-hover-select-handler';
import type {
  SolvedConstraintView, SolvedEntityView, SolvedSketchModel,
} from '../src/sketch-solver-client/model';

// Constraint-native fillet (P8): the corner math + emission recipe. The
// emission is arc + 2 coincident + 2 tangent per corner, one radius dim on
// the first arc, pairwise equal across the rest, and the corner coincidents
// removed — the constraints own the truth, the math only supplies guesses.

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

function cornerCoincident(
  line: number,
  a: { entity: number; point: string },
  b: { entity: number; point: string },
): SolvedConstraintView {
  return {
    kind: 'coincident',
    spec: { kind: 'coincident', a, b },
    obj: { sourceLocation: { filePath: '/w/p.fluid.js', line, column: 3 } },
    status: 'ok',
  } as unknown as SolvedConstraintView;
}

function makeModel(entities: SolvedEntityView[], constraints: SolvedConstraintView[] = []): SolvedSketchModel {
  return {
    entities: new Map(entities.map(e => [e.entityId, e])),
    constraints,
  } as unknown as SolvedSketchModel;
}

function edgePick(view: SolvedEntityView): SolvedPick {
  return {
    entityId: view.entityId,
    kind: view.kind as 'line' | 'arc',
    sourceLocation: (view.obj as { sourceLocation: SolvedPick['sourceLocation'] }).sourceLocation,
  };
}

/** Parse `arc([a, b], [c, d], [e, f])` (optionally `.cw()`). */
function parseArc(text: string): { start: V2; end: V2; center: V2; cw: boolean } {
  const nums = [...text.matchAll(/-?\d+(?:\.\d+)?/g)].map(m => parseFloat(m[0]));
  return {
    start: [nums[0], nums[1]],
    end: [nums[2], nums[3]],
    center: [nums[4], nums[5]],
    cw: text.includes('.cw()'),
  };
}

const near = (a: V2, b: V2, tol = 0.05): void => {
  expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeLessThan(tol);
};

describe('buildFilletEmission — line-line corners', () => {
  const l1 = lineView(0, 5, [0, 0], [100, 0]);
  const l2 = lineView(1, 6, [100, 0], [100, 50]);

  it('emits the corner recipe for a right-angle corner and removes its coincident', () => {
    const model = makeModel([l1, l2], [
      cornerCoincident(7, { entity: 0, point: 'end' }, { entity: 1, point: 'start' }),
    ]);
    const plan = buildFilletEmission({
      picks: [edgePick(l1), edgePick(l2)], model, radius: 4, radiusExpr: '4',
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) {
      return;
    }
    expect(plan.corners).toBe(1);
    expect(plan.request.geometry).toHaveLength(1);
    const arc = parseArc(plan.request.geometry[0].text);
    near(arc.start, [96, 0]);
    near(arc.end, [100, 4]);
    near(arc.center, [96, 4]);
    expect(arc.cw).toBe(false);
    expect(plan.request.constraints).toEqual([
      { kind: 'coincident', targets: [{ newIndex: 0, role: 'start' }, { line: 5, featureType: 'line', role: 'end' }] },
      { kind: 'coincident', targets: [{ newIndex: 0, role: 'end' }, { line: 6, featureType: 'line', role: 'start' }] },
      { kind: 'tangent', targets: [{ line: 5, featureType: 'line' }, { newIndex: 0 }] },
      { kind: 'tangent', targets: [{ newIndex: 0 }, { line: 6, featureType: 'line' }] },
      { kind: 'radius', targets: [{ newIndex: 0 }], valueExpr: '4' },
    ]);
    expect(plan.request.removals).toEqual([{ line: 7 }]);
  });

  it('sweeps clockwise when the corner turns the other way', () => {
    const down = lineView(1, 6, [100, 0], [100, -50]);
    const model = makeModel([l1, down]);
    const plan = buildFilletEmission({
      picks: [edgePick(l1), edgePick(down)], model, radius: 4, radiusExpr: '4',
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) {
      return;
    }
    const arc = parseArc(plan.request.geometry[0].text);
    near(arc.start, [96, 0]);
    near(arc.end, [100, -4]);
    near(arc.center, [96, -4]);
    expect(arc.cw).toBe(true);
  });

  it('emits one radius dim plus pairwise equals across a multi-corner chain', () => {
    const l3 = lineView(2, 7, [100, 50], [0, 50]);
    const model = makeModel([l1, l2, l3], [
      cornerCoincident(8, { entity: 0, point: 'end' }, { entity: 1, point: 'start' }),
      cornerCoincident(9, { entity: 1, point: 'end' }, { entity: 2, point: 'start' }),
    ]);
    const plan = buildFilletEmission({
      picks: [edgePick(l1), edgePick(l2), edgePick(l3)], model, radius: 5, radiusExpr: 'r',
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) {
      return;
    }
    expect(plan.corners).toBe(2);
    expect(plan.request.geometry).toHaveLength(2);
    const kinds = plan.request.constraints.map(c => c.kind);
    expect(kinds.filter(k => k === 'coincident')).toHaveLength(4);
    expect(kinds.filter(k => k === 'tangent')).toHaveLength(4);
    expect(plan.request.constraints.filter(c => c.kind === 'radius')).toEqual([
      { kind: 'radius', targets: [{ newIndex: 0 }], valueExpr: 'r' },
    ]);
    expect(plan.request.constraints.filter(c => c.kind === 'equal')).toEqual([
      { kind: 'equal', targets: [{ newIndex: 0 }, { newIndex: 1 }] },
    ]);
    expect(plan.request.removals).toEqual([{ line: 8 }, { line: 9 }]);
  });

  it('accepts a corner that has no coincident statement (removals stay empty)', () => {
    const model = makeModel([l1, l2]);
    const plan = buildFilletEmission({
      picks: [edgePick(l1), edgePick(l2)], model, radius: 4, radiusExpr: '4',
    });
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.request.removals).toBeUndefined();
    }
  });

  it('refuses a radius that does not fit the corner', () => {
    const model = makeModel([l1, l2]);
    const plan = buildFilletEmission({
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
    const plan = buildFilletEmission({
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
    const plan = buildFilletEmission({
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
    const plan = buildFilletEmission({
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
    const asCircle = buildFilletEmission({
      picks: [edgePick(l1), circlePick], model, radius: 4, radiusExpr: '4',
    });
    expect(asCircle.ok).toBe(false);

    const looped: SolvedPick = {
      ...edgePick(l2),
      sourceLocation: { filePath: '/w/p.fluid.js', line: 6, column: 3, occurrence: 1 },
    };
    const loopedResult = buildFilletEmission({
      picks: [edgePick(l1), looped], model: makeModel([l1, l2]), radius: 4, radiusExpr: '4',
    });
    expect(loopedResult.ok).toBe(false);

    const reference: SolvedPick = { ...edgePick(l2), reference: { refIndex: 0, producer: 'project' } };
    const refResult = buildFilletEmission({
      picks: [edgePick(l1), reference], model: makeModel([l1, l2]), radius: 4, radiusExpr: '4',
    });
    expect(refResult.ok).toBe(false);

    const copy: SolvedPick = { ...edgePick(l2), copyInstance: { slot: 1 } };
    const copyResult = buildFilletEmission({
      picks: [edgePick(l1), copy], model: makeModel([l1, l2]), radius: 4, radiusExpr: '4',
    });
    expect(copyResult.ok).toBe(false);
  });

  it('needs at least two picked edges', () => {
    const plan = buildFilletEmission({
      picks: [edgePick(l1)], model: makeModel([l1]), radius: 4, radiusExpr: '4',
    });
    expect(plan.ok).toBe(false);
  });
});

describe('buildFilletEmission — arc corners', () => {
  it('fillets a line-arc corner (offset-intersection candidates)', () => {
    // Line comes in along +x; a CW arc leaves the corner going up (center
    // to the right, so the fillet sits outside the arc).
    const l1 = lineView(0, 5, [0, 0], [100, 0]);
    const a1 = arcView(1, 6, [100, 0], [150, 50], [150, 0], 50, true);
    const model = makeModel([l1, a1], [
      cornerCoincident(7, { entity: 0, point: 'end' }, { entity: 1, point: 'start' }),
    ]);
    const plan = buildFilletEmission({
      picks: [edgePick(l1), edgePick(a1)], model, radius: 5, radiusExpr: '5',
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) {
      return;
    }
    const arc = parseArc(plan.request.geometry[0].text);
    // Fillet center: 5 above the line, 55 from the arc's center.
    expect(Math.abs(arc.center[1] - 5)).toBeLessThan(0.05);
    expect(Math.abs(Math.hypot(arc.center[0] - 150, arc.center[1]) - 55)).toBeLessThan(0.05);
    // Tangent points: on the line (y = 0) and on the arc's circle.
    expect(Math.abs(arc.start[1])).toBeLessThan(0.05);
    expect(Math.abs(Math.hypot(arc.end[0] - 150, arc.end[1]) - 50)).toBeLessThan(0.05);
    // Both fillet ends sit at the fillet radius from its center.
    expect(Math.abs(Math.hypot(arc.start[0] - arc.center[0], arc.start[1] - arc.center[1]) - 5)).toBeLessThan(0.05);
    expect(Math.abs(Math.hypot(arc.end[0] - arc.center[0], arc.end[1] - arc.center[1]) - 5)).toBeLessThan(0.05);
    expect(plan.request.removals).toEqual([{ line: 7 }]);
    expect(plan.request.constraints.map(c => c.kind))
      .toEqual(['coincident', 'coincident', 'tangent', 'tangent', 'radius']);
  });

  it('refuses a smooth (already tangent) junction', () => {
    // The arc leaves the corner along the line's own direction — no corner.
    const l1 = lineView(0, 5, [0, 0], [100, 0]);
    const a1 = arcView(1, 6, [100, 0], [150, 50], [100, 50], 50, false);
    const model = makeModel([l1, a1]);
    const plan = buildFilletEmission({
      picks: [edgePick(l1), edgePick(a1)], model, radius: 5, radiusExpr: '5',
    });
    expect(plan.ok).toBe(false);
  });
});
