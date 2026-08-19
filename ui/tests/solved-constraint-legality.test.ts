import { describe, it, expect } from 'vitest';
import {
  candidateSpec,
  constraintOptions,
  dimensionFormFor,
  dimensionPreviewLayout,
  expandDimensionPicks,
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

  it('line + circle: tangent only (the solver has no line-circle distance form)', () => {
    expect(enabledIds([lineA, circleC])).toEqual(['tangent']);
    expect(enabledIds([circleC, arcD])).toEqual(
      ['concentric', 'dimension', 'equal', 'tangent'].sort(),
    );
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
  it('selects the constraint form per pick pair', () => {
    expect(dimensionFormFor([endA, startB])).toEqual({ kind: 'distance', axisChoice: true });
    expect(dimensionFormFor([endA, lineB])).toEqual({ kind: 'distance', axisChoice: false });
    expect(dimensionFormFor([lineA, lineB])).toEqual({ kind: 'distance', axisChoice: false });
    expect(dimensionFormFor([circleC, arcD])).toEqual({ kind: 'distance', axisChoice: false });
    expect(dimensionFormFor([circleC])).toEqual({ kind: 'diameter', axisChoice: false });
    expect(dimensionFormFor([arcD])).toEqual({ kind: 'radius', axisChoice: false });
    expect(dimensionFormFor([lineA, lineA])).toBeNull();
  });

  it('a lone line dimensions its own length — the endpoint-pair distance', () => {
    expect(dimensionFormFor([lineA])).toEqual({ kind: 'distance', axisChoice: true });
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
  dof: null,
  outcome: null,
  fullyConstrained: false,
  conflictCount: 0,
  redundantCount: 0,
};

describe('measureDimension', () => {
  it('measures point pairs, with and without an axis', () => {
    const picks = [endA, { entityId: 1, kind: 'line', role: 'end', sourceLocation: loc(6) } as SolvedPick];
    const form = { kind: 'distance' as const, axisChoice: true };
    expect(measureDimension(model, picks, form)).toBe(8);
    expect(measureDimension(model, picks, form, 'x')).toBe(0);
    expect(measureDimension(model, picks, form, 'y')).toBe(8);
  });

  it('measures point–line perpendicular and point–circle gap', () => {
    const end1: SolvedPick = { entityId: 1, kind: 'line', role: 'end', sourceLocation: loc(6) };
    expect(measureDimension(model, [end1, lineA], { kind: 'distance', axisChoice: false })).toBe(8);
    expect(measureDimension(model, [endA, circleC], { kind: 'distance', axisChoice: false })).toBe(15);
  });

  it('measures angle between lines in degrees — always positive, whatever the pick order', () => {
    const angleForm = { kind: 'angle' as const, axisChoice: false };
    expect(measureDimension(model, [lineA, lineB], angleForm)).toBe(90);
    // The reversed pick order used to measure −90 (the signed directed
    // angle); a sector's angle is its own positive measure.
    expect(measureDimension(model, [lineB, lineA], angleForm)).toBe(90);
  });

  it('measures radius and diameter', () => {
    expect(measureDimension(model, [circleC], { kind: 'radius', axisChoice: false })).toBe(5);
    expect(measureDimension(model, [circleC], { kind: 'diameter', axisChoice: false })).toBe(10);
  });

  it('measures a lone line as its length', () => {
    expect(measureDimension(model, [lineA], { kind: 'distance', axisChoice: true })).toBe(10);
    expect(measureDimension(model, [lineB], { kind: 'distance', axisChoice: true })).toBe(8);
  });
});

describe('dimensionPreviewLayout', () => {
  const distance = { kind: 'distance' as const, axisChoice: true };
  const end1: SolvedPick = { entityId: 1, kind: 'line', role: 'end', sourceLocation: loc(6) };

  it('point–point: leader between the vertices, input at the midpoint', () => {
    expect(dimensionPreviewLayout(model, [endA, end1], distance)).toEqual({
      line: [[10, 0], [10, 8]],
      at: [10, 4],
    });
  });

  it('a lone line: leader along the line, input at its midpoint', () => {
    expect(dimensionPreviewLayout(model, [lineA], distance)).toEqual({
      line: [[0, 0], [10, 0]],
      at: [5, 0],
    });
  });

  it('point–line: leader from the point to its perpendicular foot', () => {
    expect(dimensionPreviewLayout(model, [end1, lineA], { kind: 'distance', axisChoice: false })).toEqual({
      line: [[10, 8], [10, 0]],
      at: [10, 4],
    });
  });

  it('radius: leader from the center to the rim label spot', () => {
    const layout = dimensionPreviewLayout(model, [circleC], { kind: 'radius', axisChoice: false });
    expect(layout).not.toBeNull();
    expect(layout!.line![0]).toEqual([30, 0]);
    expect(layout!.line![1][0]).toBeCloseTo(30 + 5 * Math.SQRT1_2, 10);
    expect(layout!.at).toEqual(layout!.line![1]);
  });

  it('angle: no leader, sector arc at the line intersection', () => {
    // The default sector's a-boundary ray (+x) points AWAY from a's
    // segment (the intersection is a's far endpoint) — the arc's end
    // needs the dashed tail stub there; b's segment covers its ray.
    expect(dimensionPreviewLayout(model, [lineA, lineB], { kind: 'angle', axisChoice: false })).toEqual({
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
