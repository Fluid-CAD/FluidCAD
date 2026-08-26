import { describe, it, expect } from 'vitest';
import {
  axisDimensionPicks,
  axisFromCursor,
  candidateSpec,
  constraintOptions,
  dimensionFormFor,
  dimensionPreviewLayout,
  distancePlacementMoot,
  expandDimensionPicks,
  inferTangency,
  measureDimension,
} from '../src/interactive/solved-constraint-toolbar/legality';
import { angleSectorAt } from '../src/interactive/solved-constraint-toolbar/angle-sector';
import type { SolvedPick } from '../src/interactive/sketch-hover-select-handler';
import type { SolvedEntityView, SolvedSketchModel } from '../src/sketch-solver-client/model';

const loc = (line: number) => ({ filePath: '/ws/m.fluid.js', line, column: 3 });

const lineA: SolvedPick = { entityId: 0, kind: 'line', sourceLocation: loc(5) };
const lineB: SolvedPick = { entityId: 1, kind: 'line', sourceLocation: loc(6) };
const circleC: SolvedPick = { entityId: 2, kind: 'circle', sourceLocation: loc(7) };
const arcD: SolvedPick = { entityId: 3, kind: 'arc', sourceLocation: loc(8) };
const endA: SolvedPick = { entityId: 0, kind: 'line', role: 'end', sourceLocation: loc(5) };
const startB: SolvedPick = { entityId: 1, kind: 'line', role: 'start', sourceLocation: loc(6) };
const pointP: SolvedPick = { entityId: 4, kind: 'point', sourceLocation: loc(9) };

function enabledIds(picks: SolvedPick[]): string[] {
  return constraintOptions(picks).filter(o => o.enabled).map(o => o.id).sort();
}

describe('constraintOptions', () => {
  it('one line: horizontal/vertical, and dimension (its own length)', () => {
    expect(enabledIds([lineA])).toEqual(['dimension', 'horizontal', 'vertical']);
  });

  it('two lines: the line-pair family + dimension/angle', () => {
    expect(enabledIds([lineA, lineB])).toEqual(
      ['angle', 'collinear', 'dimension', 'equal', 'parallel', 'perpendicular'].sort(),
    );
  });

  it('the same line twice enables nothing pairwise', () => {
    expect(enabledIds([lineA, { ...lineA }])).toEqual([]);
  });

  it('two vertices: coincident, H/V point-pair, dimension', () => {
    expect(enabledIds([endA, startB])).toEqual(
      ['coincident', 'dimension', 'horizontal', 'vertical'].sort(),
    );
  });

  it('vertex + entity: coincident (point-on), midpoint on lines, dimension', () => {
    expect(enabledIds([endA, lineB])).toEqual(['coincident', 'dimension', 'midpoint'].sort());
    expect(enabledIds([endA, circleC])).toEqual(['coincident', 'dimension'].sort());
  });

  it('line + circle: tangent, and dimension (gap to the circumference)', () => {
    expect(enabledIds([lineA, circleC])).toEqual(['dimension', 'tangent']);
    expect(enabledIds([circleC, arcD])).toEqual(
      ['concentric', 'dimension', 'equal', 'tangent'].sort(),
    );
  });

  it('three or more homogeneous entities: variadic equal/parallel', () => {
    const lineE: SolvedPick = { entityId: 5, kind: 'line', sourceLocation: loc(10) };
    const circleF: SolvedPick = { entityId: 6, kind: 'circle', sourceLocation: loc(11) };
    expect(enabledIds([lineA, lineB, lineE])).toEqual(['equal', 'parallel']);
    expect(enabledIds([circleC, arcD, circleF])).toEqual(['equal']);
    // Mixed families and duplicate picks disable them.
    expect(enabledIds([lineA, lineB, circleC])).toEqual([]);
    expect(enabledIds([lineA, lineB, { ...lineA }])).toEqual([]);
    // Everything after the first pick is constrained against it.
    expect(candidateSpec('equal', [lineA, lineB, lineE])).toEqual({
      kind: 'equal', a: { entity: 0 }, b: { entity: 1 }, others: [{ entity: 5 }],
    });
    expect(candidateSpec('equal', [lineA, lineB])).toEqual({
      kind: 'equal', a: { entity: 0 }, b: { entity: 1 },
    });
    expect(candidateSpec('parallel', [lineA, lineB, lineE])).toEqual({
      kind: 'parallel', a: { entity: 0 }, b: { entity: 1 }, others: [{ entity: 5 }],
    });
    expect(candidateSpec('parallel', [lineA, lineB])).toEqual({
      kind: 'parallel', a: { entity: 0 }, b: { entity: 1 },
    });
  });

  it('three or more points: variadic horizontal/vertical (point form)', () => {
    const centerC: SolvedPick = { entityId: 2, kind: 'circle', role: 'center', sourceLocation: loc(7) };
    expect(enabledIds([endA, startB, centerC])).toEqual(['horizontal', 'vertical']);
    // A line pick among the points breaks the point form.
    expect(enabledIds([endA, startB, lineB])).toContain('symmetric');
    expect(enabledIds([endA, startB, lineB])).not.toContain('horizontal');
    // Everything after the first pick aligns to it.
    expect(candidateSpec('horizontal', [endA, startB, centerC])).toEqual({
      kind: 'horizontal',
      a: { entity: 0, point: 'end' },
      b: { entity: 1, point: 'start' },
      others: [{ entity: 2, point: 'center' }],
    });
    expect(candidateSpec('vertical', [endA, startB])).toEqual({
      kind: 'vertical', a: { entity: 0, point: 'end' }, b: { entity: 1, point: 'start' },
    });
  });

  it('copy duplicates participate as their geometric kind — free, not fixed', () => {
    const copyLine: SolvedPick = {
      entityId: 7, kind: 'line', sourceLocation: loc(12), copyInstance: { slot: 1 },
    };
    // A duplicate line is a line: the full line-pair family with a plain line.
    expect(enabledIds([copyLine, lineB])).toEqual(
      ['angle', 'collinear', 'dimension', 'equal', 'parallel', 'perpendicular'].sort(),
    );
    // A duplicate against its own SOURCE is two entityIds — a legal pair.
    expect(enabledIds([copyLine, lineA])).toContain('parallel');
    // Two duplicate slots are two entityIds too — nothing all-fixed here.
    const copyLine2: SolvedPick = {
      entityId: 8, kind: 'line', sourceLocation: loc(12), copyInstance: { slot: 2 },
    };
    expect(enabledIds([copyLine, copyLine2])).toContain('parallel');
    expect(candidateSpec('parallel', [copyLine, copyLine2])).toEqual({
      kind: 'parallel', a: { entity: 7 }, b: { entity: 8 },
    });
  });

  it('one vertex: fix; a point entity counts as a point', () => {
    expect(enabledIds([endA])).toEqual(['fix']);
    expect(enabledIds([pointP])).toEqual(['dimension', 'fix'].sort().filter(id => id !== 'dimension'));
  });

  it('two points + line: symmetric', () => {
    expect(enabledIds([endA, startB, lineA]).includes('symmetric')).toBe(true);
  });

  it('REGRESSION: a point never pairs with its OWN entity — a line grabbed as an edge next to its endpoint must not offer the degenerate point-on-own-line forms', () => {
    // distance(l2, l2.start(), …) is identically zero — the exact statement
    // a near-endpoint mis-pick emitted (Marwan's triangle report).
    const startA: SolvedPick = { entityId: 0, kind: 'line', role: 'start', sourceLocation: loc(5) };
    expect(enabledIds([lineA, startA])).toEqual([]);
    expect(dimensionFormFor([lineA, startA])).toBeNull();
    expect(dimensionFormFor([startA, lineA])).toBeNull();
    // Same guard for circles: the center against its own circle is a radius
    // in disguise — the single-pick diameter form owns that.
    const centerC: SolvedPick = { entityId: 2, kind: 'circle', role: 'center', sourceLocation: loc(7) };
    expect(dimensionFormFor([centerC, circleC])).toBeNull();
    expect(enabledIds([centerC, circleC])).toEqual([]);
    // Cross-entity point-on stays legal.
    expect(enabledIds([startA, lineB]).sort()).toEqual(['coincident', 'dimension', 'midpoint'].sort());
  });
});

describe('dimensionFormFor', () => {
  it('selects the constraint form per pick pair; circle/arc pairs offer the tangency choice; point/round pairs offer the axis choice', () => {
    expect(dimensionFormFor([endA, startB])).toEqual({ kind: 'distance', axisChoice: true, tangencyChoice: false });
    expect(dimensionFormFor([endA, lineB])).toEqual({ kind: 'distance', axisChoice: false, tangencyChoice: false });
    expect(dimensionFormFor([endA, circleC])).toEqual({ kind: 'distance', axisChoice: true, tangencyChoice: true });
    expect(dimensionFormFor([lineA, lineB])).toEqual({ kind: 'distance', axisChoice: false, tangencyChoice: false });
    expect(dimensionFormFor([circleC, arcD])).toEqual({ kind: 'distance', axisChoice: true, tangencyChoice: true });
    expect(dimensionFormFor([lineA, circleC])).toEqual({ kind: 'distance', axisChoice: false, tangencyChoice: true });
    expect(dimensionFormFor([arcD, lineB])).toEqual({ kind: 'distance', axisChoice: false, tangencyChoice: true });
    expect(dimensionFormFor([circleC])).toEqual({ kind: 'diameter', axisChoice: false, tangencyChoice: false });
    expect(dimensionFormFor([arcD])).toEqual({ kind: 'radius', axisChoice: false, tangencyChoice: false });
    expect(dimensionFormFor([lineA, lineA])).toBeNull();
  });

  it('a lone line dimensions its own length — the endpoint-pair distance', () => {
    expect(dimensionFormFor([lineA])).toEqual({ kind: 'distance', axisChoice: true, tangencyChoice: false });
    expect(expandDimensionPicks([lineA])).toEqual([
      { ...lineA, role: 'start' },
      { ...lineA, role: 'end' },
    ]);
    // Expansion is lone-line only: vertex picks and pairs pass through.
    expect(expandDimensionPicks([endA])).toEqual([endA]);
    expect(expandDimensionPicks([lineA, lineB])).toEqual([lineA, lineB]);
    expect(expandDimensionPicks([circleC])).toEqual([circleC]);
  });
});

describe('axisDimensionPicks', () => {
  it('passes point pairs through, expands a lone line to its endpoints', () => {
    expect(axisDimensionPicks([endA, startB])).toEqual([endA, startB]);
    expect(axisDimensionPicks([lineA])).toEqual([
      { ...lineA, role: 'start' },
      { ...lineA, role: 'end' },
    ]);
  });

  it('substitutes circle/arc picks with their centers', () => {
    expect(axisDimensionPicks([endA, circleC])).toEqual([endA, { ...circleC, role: 'center' }]);
    expect(axisDimensionPicks([circleC, arcD])).toEqual([
      { ...circleC, role: 'center' },
      { ...arcD, role: 'center' },
    ]);
  });

  it('line picks (other than the lone-line expansion) have no axis form', () => {
    expect(axisDimensionPicks([lineA, lineB])).toBeNull();
    expect(axisDimensionPicks([endA, lineB])).toBeNull();
    expect(axisDimensionPicks([lineA, circleC])).toBeNull();
    expect(axisDimensionPicks([endA])).toBeNull();
  });
});

describe('axisFromCursor', () => {
  const a: [number, number] = [0, 0];
  const b: [number, number] = [10, 8];

  it('the smart-dimension regions: above/below within the x-range → x, beside within the y-range → y, inside or diagonal → aligned', () => {
    expect(axisFromCursor(a, b, [5, 20])).toBe('x');
    expect(axisFromCursor(a, b, [5, -3])).toBe('x');
    expect(axisFromCursor(a, b, [-4, 4])).toBe('y');
    expect(axisFromCursor(a, b, [15, 4])).toBe('y');
    expect(axisFromCursor(a, b, [5, 4])).toBeUndefined();
    expect(axisFromCursor(a, b, [20, 20])).toBeUndefined();
    expect(axisFromCursor(a, b, [-3, -3])).toBeUndefined();
  });

  it('never offers an axis whose measure rounds to zero', () => {
    // A horizontal pair: the y sliver would dimension Δy = 0.
    expect(axisFromCursor([0, 0], [10, 0], [20, 0])).toBeUndefined();
    expect(axisFromCursor([0, 0], [10, 0], [5, 5])).toBe('x');
    expect(axisFromCursor([0, 0], [0, 8], [0.0, 20])).toBeUndefined();
    expect(axisFromCursor([0, 0], [0, 8], [5, 4])).toBe('y');
  });
});

describe('distancePlacementMoot', () => {
  it('an axis-aligned point pair skips placement — the only axis measures the aligned value', () => {
    expect(distancePlacementMoot([endA, startB], [0, 0], [10, 0])).toBe(true);
    expect(distancePlacementMoot([endA, startB], [3, -2], [3, 9])).toBe(true);
  });

  it('a diagonal pair still places', () => {
    expect(distancePlacementMoot([endA, startB], [0, 0], [10, 8])).toBe(false);
  });

  it('round targets always place — their aligned form measures the circumference, not the centers', () => {
    expect(distancePlacementMoot([pointP, circleC], [0, 0], [10, 0])).toBe(false);
  });
});

// ---------------------------------------------------------------------------

function entityView(entityId: number, fields: Partial<SolvedEntityView> & { kind: SolvedEntityView['kind'] }): SolvedEntityView {
  return { entityId, obj: { id: `obj-${entityId}` } as any, ...fields };
}

const model: SolvedSketchModel = {
  sketch: {} as any,
  plane: {} as any,
  solver: null,
  entities: new Map([
    [0, entityView(0, { kind: 'line', start: [0, 0], end: [10, 0] })],
    [1, entityView(1, { kind: 'line', start: [10, 0], end: [10, 8] })],
    [2, entityView(2, { kind: 'circle', center: [30, 0], radius: 5 })],
  ] as [number, SolvedEntityView][]),
  constraints: [],
  conflictingEntityIds: new Set(),
  constrainedEntityIds: new Set(),
  referenceProducers: new Map(),
  derivedProducers: new Map(),
  dof: null,
  outcome: null,
  fullyConstrained: false,
  conflictCount: 0,
  redundantCount: 0,
  hasDatums: false,
};

describe('measureDimension', () => {
  it('measures point pairs, with and without an axis', () => {
    const picks = [endA, { entityId: 1, kind: 'line', role: 'end', sourceLocation: loc(6) } as SolvedPick];
    const form = { kind: 'distance' as const, axisChoice: true, tangencyChoice: false };
    expect(measureDimension(model, picks, form)).toBe(8);
    expect(measureDimension(model, picks, form, 'x')).toBe(0);
    expect(measureDimension(model, picks, form, 'y')).toBe(8);
  });

  it('measures point–line perpendicular and point–circle gap', () => {
    const end1: SolvedPick = { entityId: 1, kind: 'line', role: 'end', sourceLocation: loc(6) };
    expect(measureDimension(model, [end1, lineA], { kind: 'distance', axisChoice: false, tangencyChoice: false })).toBe(8);
    expect(measureDimension(model, [endA, circleC], { kind: 'distance', axisChoice: false, tangencyChoice: false })).toBe(15);
  });

  it('measures angle between lines in degrees — always positive, whatever the pick order', () => {
    const angleForm = { kind: 'angle' as const, axisChoice: false, tangencyChoice: false };
    expect(measureDimension(model, [lineA, lineB], angleForm)).toBe(90);
    // The reversed pick order used to measure −90 (the signed directed
    // angle); a sector's angle is its own positive measure.
    expect(measureDimension(model, [lineB, lineA], angleForm)).toBe(90);
  });

  it('measures radius and diameter', () => {
    expect(measureDimension(model, [circleC], { kind: 'radius', axisChoice: false, tangencyChoice: false })).toBe(5);
    expect(measureDimension(model, [circleC], { kind: 'diameter', axisChoice: false, tangencyChoice: false })).toBe(10);
  });

  it('measures line–circle as the perpendicular gap to the circumference', () => {
    const form = { kind: 'distance' as const, axisChoice: false, tangencyChoice: false };
    // Center (30,0) is 20 off lineB's infinite line (x=10); r=5 → gap 15.
    expect(measureDimension(model, [lineB, circleC], form)).toBe(15);
    expect(measureDimension(model, [circleC, lineB], form)).toBe(15);
  });

  it('measures the FAR side under the max tangency condition', () => {
    const form = { kind: 'distance' as const, axisChoice: false, tangencyChoice: true };
    // Line–circle: 20 + r 5; point–circle: d 20 + r 5.
    expect(measureDimension(model, [lineB, circleC], form, undefined, null, 'max')).toBe(25);
    expect(measureDimension(model, [endA, circleC], form, undefined, null, 'max')).toBe(25);
  });

  it('measures center-substituted round picks along an axis (the placement flow)', () => {
    const center2: SolvedPick = { ...circleC, role: 'center' };
    const form = { kind: 'distance' as const, axisChoice: true, tangencyChoice: false };
    // endA (10,0) to circleC's center (30,0).
    expect(measureDimension(model, [endA, center2], form)).toBe(20);
    expect(measureDimension(model, [endA, center2], form, 'x')).toBe(20);
    expect(measureDimension(model, [endA, center2], form, 'y')).toBe(0);
  });

  it('measures a lone line as its length', () => {
    expect(measureDimension(model, [lineA], { kind: 'distance', axisChoice: true, tangencyChoice: false })).toBe(10);
    expect(measureDimension(model, [lineB], { kind: 'distance', axisChoice: true, tangencyChoice: false })).toBe(8);
  });
});

describe('inferTangency', () => {
  const form = { kind: 'distance' as const, axisChoice: false, tangencyChoice: true };

  it('reads min from a near-side touch, max from a far-side touch', () => {
    // lineB is x=10; circleC center (30,0) r=5 — near rim faces the line.
    expect(inferTangency(model, [lineB, { ...circleC, at: [25.2, 0.4] }], form)).toBe('min');
    expect(inferTangency(model, [lineB, { ...circleC, at: [34.8, 0.4] }], form)).toBe('max');
    // Pick order doesn't matter — the touch is on the circle either way.
    expect(inferTangency(model, [{ ...circleC, at: [34.8, 0.4] }, lineB], form)).toBe('max');
  });

  it('point–circle touches work the same way', () => {
    // endA is (10,0): the near rim is at x=25, the far rim at x=35.
    expect(inferTangency(model, [endA, { ...circleC, at: [26, 1] }], form)).toBe('min');
    expect(inferTangency(model, [endA, { ...circleC, at: [34, -1] }], form)).toBe('max');
  });

  it('defaults to min without a touch or a tangency choice', () => {
    expect(inferTangency(model, [lineB, circleC], form)).toBe('min');
    expect(inferTangency(
      model,
      [lineA, { ...lineB, at: [10, 4] }],
      { kind: 'distance', axisChoice: false, tangencyChoice: false },
    )).toBe('min');
  });
});

describe('dimensionPreviewLayout', () => {
  const distance = { kind: 'distance' as const, axisChoice: true, tangencyChoice: false };
  const end1: SolvedPick = { entityId: 1, kind: 'line', role: 'end', sourceLocation: loc(6) };

  /** The lifted-leader standoff (12% of the span), in the same float ops
   * distanceLeaderLayout performs so equality stays exact. */
  const lift = (span: number): number => span * 0.12;

  it('point–point on a straight edge: leader LIFTED off it, witnesses back to the vertices', () => {
    // (10,0)→(10,8) lies exactly on lineB — the leader lifts 12% of the
    // span to the side away from the centroid (leftward here), and dashed
    // witnesses tie the lifted ends back to the measured vertices.
    const x = 10 - lift(8);
    expect(dimensionPreviewLayout(model, [endA, end1], distance)).toEqual({
      line: [[x, 0], [x, 8]],
      at: [x, 4],
      arrows: 'both',
      extensions: [[[10, 0], [x, 0]], [[10, 8], [x, 8]]],
    });
  });

  it('a lone line: leader lifted parallel to the line, input at its midpoint', () => {
    const y = -lift(10);
    expect(dimensionPreviewLayout(model, [lineA], distance)).toEqual({
      line: [[0, y], [10, y]],
      at: [5, y],
      arrows: 'both',
      extensions: [[[0, 0], [0, y]], [[10, 0], [10, y]]],
    });
  });

  it('axis forms: leader drawn axis-aligned from the first anchor, dashed witness extension to the floating far point', () => {
    const start0: SolvedPick = { entityId: 0, kind: 'line', role: 'start', sourceLocation: loc(5) };
    const y = -lift(10);
    // start0 (0,0), end1 (10,8). The x form's leader runs along lineA, so
    // it lifts too, and the far witness ties the lifted corner to the REAL
    // second point.
    expect(dimensionPreviewLayout(model, [start0, end1], distance, 'x')).toEqual({
      line: [[0, y], [10, y]],
      at: [5, y],
      arrows: 'both',
      extensions: [[[0, 0], [0, y]], [[10, 8], [10, y]]],
    });
    // The y form's leader (x=0) rides no edge — drawn in place.
    expect(dimensionPreviewLayout(model, [start0, end1], distance, 'y')).toEqual({
      line: [[0, 0], [0, 8]],
      at: [0, 4],
      arrows: 'both',
      extensions: [[[0, 8], [10, 8]]],
    });
    // A pair already on the axis needs no corner witness — but it rides
    // lineA, so it lifts like the aligned form.
    expect(dimensionPreviewLayout(model, [endA, { ...endA, role: 'start' }], distance, 'x')).toEqual({
      line: [[10, y], [0, y]],
      at: [5, y],
      arrows: 'both',
      extensions: [[[10, 0], [10, y]], [[0, 0], [0, y]]],
    });
  });

  it('point–line: leader from the point to its perpendicular foot, lifted off the edge it rides', () => {
    // end1's drop onto lineA runs straight down lineB — lifted leftward.
    const x = 10 - lift(8);
    expect(dimensionPreviewLayout(model, [end1, lineA], { kind: 'distance', axisChoice: false, tangencyChoice: false })).toEqual({
      line: [[x, 8], [x, 0]],
      at: [x, 4],
      arrows: 'both',
      extensions: [[[10, 8], [x, 8]], [[10, 0], [x, 0]]],
    });
  });

  it('line–circle: leader from the rim to the center\'s foot on the line', () => {
    expect(dimensionPreviewLayout(model, [lineB, circleC], { kind: 'distance', axisChoice: false, tangencyChoice: false })).toEqual({
      line: [[25, 0], [10, 0]],
      at: [17.5, 0],
      arrows: 'both',
    });
  });

  it('line–circle max: leader from the FAR rim to the foot', () => {
    const form = { kind: 'distance' as const, axisChoice: false, tangencyChoice: true };
    expect(dimensionPreviewLayout(model, [lineB, circleC], form, undefined, null, 'max')).toEqual({
      line: [[35, 0], [10, 0]],
      at: [22.5, 0],
      arrows: 'both',
    });
  });

  it('radius: leader from the center to the rim, input riding the line', () => {
    const layout = dimensionPreviewLayout(model, [circleC], { kind: 'radius', axisChoice: false, tangencyChoice: false });
    expect(layout).not.toBeNull();
    expect(layout!.line![0]).toEqual([30, 0]);
    expect(layout!.line![1][0]).toBeCloseTo(30 + 5 * Math.SQRT1_2, 10);
    // The input opens on the label spot: halfway along the radius.
    expect(layout!.at[0]).toBeCloseTo((30 + layout!.line![1][0]) / 2, 10);
    expect(layout!.at[1]).toBeCloseTo(layout!.line![1][1] / 2, 10);
    // The center end measures nothing, so only the rim gets an arrowhead.
    expect(layout!.arrows).toBe('end');
  });

  it('diameter: leader rim to rim through the center, input on the label spot', () => {
    const form = { kind: 'diameter' as const, axisChoice: false, tangencyChoice: false };
    const layout = dimensionPreviewLayout(model, [circleC], form);
    expect(layout).not.toBeNull();
    const [from, to] = layout!.line!;
    expect(Math.hypot(to[0] - from[0], to[1] - from[1])).toBeCloseTo(10, 9);
    expect(Math.hypot(from[0] - 30, from[1])).toBeCloseTo(5, 9);
    expect(layout!.at[0]).toBeCloseTo(30, 9);
    expect(layout!.at[1]).toBeCloseTo(0, 9);
  });

  it('angle: no leader, sector arc at the line intersection', () => {
    // The default sector's a-boundary ray (+x) points AWAY from a's
    // segment (the intersection is a's far endpoint) — the arc's end
    // needs the dashed tail stub there; b's segment covers its ray.
    expect(dimensionPreviewLayout(model, [lineA, lineB], { kind: 'angle', axisChoice: false, tangencyChoice: false })).toEqual({
      line: null,
      at: [10, 0],
      arc: { startAngle: 0, sweep: Math.PI / 2, extensions: [], tails: [0] },
    });
  });
});

describe('candidateSpec', () => {
  it('builds refs per kind with correct roles', () => {
    expect(candidateSpec('coincident', [endA, startB])).toEqual({
      kind: 'coincident', a: { entity: 0, point: 'end' }, b: { entity: 1, point: 'start' },
    });
    expect(candidateSpec('horizontal', [lineA])).toEqual({ kind: 'horizontal', a: { entity: 0 } });
    expect(candidateSpec('midpoint', [lineB, endA])).toEqual({
      kind: 'midpoint', p: { entity: 0, point: 'end' }, l: { entity: 1 },
    });
    expect(candidateSpec('fix', [pointP])).toEqual({ kind: 'fix', p: { entity: 4 } });
  });

  it('angle converts degrees to radians via its sector; dimension picks its constraint kind', () => {
    const sector = angleSectorAt(model, lineA, lineB, null)!;
    const angle = candidateSpec('angle', [lineA, lineB], 90, undefined, sector);
    expect(angle).toEqual({ kind: 'angle', a: { entity: 0 }, b: { entity: 1 }, value: Math.PI / 2 });
    expect(candidateSpec('dimension', [circleC], 10)).toEqual({
      kind: 'diameter', a: { entity: 2 }, value: 10,
    });
    expect(candidateSpec('dimension', [endA, startB], 8, 'y')).toEqual({
      kind: 'distance', a: { entity: 0, point: 'end' }, b: { entity: 1, point: 'start' }, value: 8, axis: 'y',
    });
  });

  it('max tangency rides the spec only when the pair has a circle/arc', () => {
    expect(candidateSpec('dimension', [lineB, circleC], 25, undefined, null, 'max')).toEqual({
      kind: 'distance', a: { entity: 1 }, b: { entity: 2 }, value: 25, tangency: 'max',
    });
    // Point pairs have no tangency side — a stray 'max' is dropped.
    expect(candidateSpec('dimension', [endA, startB], 8, undefined, null, 'max')).toEqual({
      kind: 'distance', a: { entity: 0, point: 'end' }, b: { entity: 1, point: 'start' }, value: 8,
    });
  });

  it('a lone-line dimension expands to the endpoint-pair distance', () => {
    expect(candidateSpec('dimension', [lineA], 10)).toEqual({
      kind: 'distance', a: { entity: 0, point: 'start' }, b: { entity: 0, point: 'end' }, value: 10,
    });
  });

  it('returns null for illegal picks or missing values/sector', () => {
    expect(candidateSpec('tangent', [lineA, lineB])).toBeNull();
    expect(candidateSpec('angle', [lineA, lineB])).toBeNull();
    expect(candidateSpec('angle', [lineA, lineB], 90)).toBeNull();
  });
});
