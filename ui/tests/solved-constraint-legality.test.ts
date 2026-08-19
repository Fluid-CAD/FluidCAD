import { describe, it, expect } from 'vitest';
import {
  candidateSpec,
  constraintOptions,
  dimensionFormFor,
  measureDimension,
} from '../src/interactive/solved-constraint-toolbar/legality';
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
  it('one line: horizontal/vertical only', () => {
    expect(enabledIds([lineA])).toEqual(['horizontal', 'vertical']);
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
});

describe('dimensionFormFor', () => {
  it('selects the constraint form per pick pair', () => {
    expect(dimensionFormFor([endA, startB])).toEqual({ kind: 'distance', axisChoice: true });
    expect(dimensionFormFor([endA, lineB])).toEqual({ kind: 'distance', axisChoice: false });
    expect(dimensionFormFor([lineA, lineB])).toEqual({ kind: 'distance', axisChoice: false });
    expect(dimensionFormFor([circleC, arcD])).toEqual({ kind: 'distance', axisChoice: false });
    expect(dimensionFormFor([circleC])).toEqual({ kind: 'diameter', axisChoice: false });
    expect(dimensionFormFor([arcD])).toEqual({ kind: 'radius', axisChoice: false });
    expect(dimensionFormFor([lineA])).toBeNull();
    expect(dimensionFormFor([lineA, lineA])).toBeNull();
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

  it('measures angle between lines in degrees', () => {
    expect(measureDimension(model, [lineA, lineB], { kind: 'angle', axisChoice: false })).toBe(90);
  });

  it('measures radius and diameter', () => {
    expect(measureDimension(model, [circleC], { kind: 'radius', axisChoice: false })).toBe(5);
    expect(measureDimension(model, [circleC], { kind: 'diameter', axisChoice: false })).toBe(10);
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

  it('angle converts degrees to radians; dimension picks its constraint kind', () => {
    const angle = candidateSpec('angle', [lineA, lineB], 90);
    expect(angle).toMatchObject({ kind: 'angle' });
    expect((angle as any).value).toBeCloseTo(Math.PI / 2, 12);
    expect(candidateSpec('dimension', [circleC], 10)).toEqual({
      kind: 'diameter', a: { entity: 2 }, value: 10,
    });
    expect(candidateSpec('dimension', [endA, startB], 8, 'y')).toEqual({
      kind: 'distance', a: { entity: 0, point: 'end' }, b: { entity: 1, point: 'start' }, value: 8, axis: 'y',
    });
  });

  it('returns null for illegal picks or missing values', () => {
    expect(candidateSpec('tangent', [lineA, lineB])).toBeNull();
    expect(candidateSpec('angle', [lineA, lineB])).toBeNull();
  });
});
