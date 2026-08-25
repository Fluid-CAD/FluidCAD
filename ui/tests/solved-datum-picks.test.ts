import { describe, it, expect } from 'vitest';
import {
  candidateSpec,
  constraintOptions,
  dimensionFormFor,
  expandDimensionPicks,
  measureDimension,
  normalizeDistancePicks,
} from '../src/interactive/solved-constraint-toolbar/legality';
import { datumHitTest } from '../src/sketch-solver-client/hit-test';
import { entityFor, refPoint } from '../src/sketch-solver-client/resolve';
import { refTarget } from '../src/interactive/tools/solved-emission';
import { AxisSnapper } from '../src/snapping/axis-snapper';
import type { SolvedPick } from '../src/interactive/sketch-hover-select-handler';
import type { SolvedEntityView, SolvedSketchModel } from '../src/sketch-solver-client/model';
import type { PlaneData } from '../src/types';

// Datum picks (origin + axes): hit-test priority shapes, legality guards
// mirroring the kernel's, resolve synthesis, and snap/emission plumbing.

const loc = (line: number) => ({ filePath: '/ws/m.fluid.js', line, column: 3 });

const lineA: SolvedPick = { entityId: 0, kind: 'line', sourceLocation: loc(5) };
const endA: SolvedPick = { entityId: 0, kind: 'line', role: 'end', sourceLocation: loc(5) };
const startA: SolvedPick = { entityId: 0, kind: 'line', role: 'start', sourceLocation: loc(5) };
const circleC: SolvedPick = { entityId: 2, kind: 'circle', sourceLocation: loc(7) };
const originPick: SolvedPick = { entityId: -1, kind: 'point', datum: 'origin' };
const xAxisPick: SolvedPick = { entityId: -2, kind: 'line', datum: 'x-axis' };
const yAxisPick: SolvedPick = { entityId: -3, kind: 'line', datum: 'y-axis' };

function model(entities: SolvedEntityView[], hasDatums = true): SolvedSketchModel {
  return {
    sketch: {} as any,
    plane: {} as any,
    solver: null,
    entities: new Map(entities.map(e => [e.entityId, e])),
    constraints: [],
    hasDatums,
    conflictingEntityIds: new Set(),
    constrainedEntityIds: new Set(),
    referenceProducers: new Map(),
    derivedProducers: new Map(),
    dof: null,
    outcome: null,
    fullyConstrained: false,
    conflictCount: 0,
    redundantCount: 0,
  };
}

const lineView: SolvedEntityView = {
  entityId: 0, kind: 'line', start: [10, 20], end: [50, 20], obj: { sourceLocation: loc(5) } as any,
};

function enabledIds(picks: SolvedPick[]): string[] {
  return constraintOptions(picks).filter(o => o.enabled).map(o => o.id).sort();
}

describe('datum legality', () => {
  it('vertex + origin: coincident, H/V point pair, dimension', () => {
    expect(enabledIds([endA, originPick])).toEqual(
      ['coincident', 'dimension', 'horizontal', 'vertical'].sort(),
    );
  });

  it('line + axis: the line-pair family minus equal', () => {
    expect(enabledIds([lineA, xAxisPick])).toEqual(
      ['angle', 'collinear', 'dimension', 'parallel', 'perpendicular'].sort(),
    );
  });

  it('vertex + axis: coincident (point-on-axis) and dimension, never midpoint', () => {
    expect(enabledIds([endA, yAxisPick])).toEqual(['coincident', 'dimension'].sort());
  });

  it('two vertices + axis: symmetric about the axis', () => {
    expect(enabledIds([startA, endA, yAxisPick]).includes('symmetric')).toBe(true);
  });

  it('circle + axis: tangent and dimension', () => {
    expect(enabledIds([circleC, xAxisPick])).toEqual(['dimension', 'tangent'].sort());
  });

  it('all-datum pick sets enable nothing', () => {
    expect(enabledIds([originPick])).toEqual([]);
    expect(enabledIds([originPick, xAxisPick])).toEqual([]);
    expect(enabledIds([xAxisPick, yAxisPick])).toEqual([]);
  });

  it('a lone axis neither dimensions nor goes horizontal/vertical', () => {
    expect(enabledIds([xAxisPick])).toEqual([]);
    expect(dimensionFormFor([xAxisPick])).toBeNull();
    expect(expandDimensionPicks([xAxisPick])).toEqual([xAxisPick]);
  });

  it('normalizeDistancePicks puts an axis passed second into the a slot', () => {
    expect(normalizeDistancePicks([lineA, xAxisPick])).toEqual([xAxisPick, lineA]);
    // Point + axis and axis-first orders pass through untouched.
    expect(normalizeDistancePicks([endA, xAxisPick])).toEqual([endA, xAxisPick]);
    expect(normalizeDistancePicks([xAxisPick, lineA])).toEqual([xAxisPick, lineA]);
  });

  it('candidateSpec renders datum refs with the reserved entity ids', () => {
    const spec = candidateSpec('coincident', [endA, originPick]);
    expect(spec).toEqual({ kind: 'coincident', a: { entity: 0, point: 'end' }, b: { entity: -1 } });
    const sym = candidateSpec('symmetric', [startA, endA, yAxisPick]);
    expect(sym).toEqual({
      kind: 'symmetric',
      a: { entity: 0, point: 'start' },
      b: { entity: 0, point: 'end' },
      l: { entity: -3 },
    });
  });

  it('measures a line–axis distance from the axis (midpoint of the LINE)', () => {
    const m = model([lineView]);
    const form = dimensionFormFor([lineA, xAxisPick]);
    expect(form?.kind).toBe('distance');
    // Line at y=20: perpendicular distance from the x axis is 20 regardless
    // of pick order (normalization puts the axis in the carrier slot).
    expect(measureDimension(m, [lineA, xAxisPick], form!)).toBeCloseTo(20, 6);
    expect(measureDimension(m, [xAxisPick, lineA], form!)).toBeCloseTo(20, 6);
  });
});

describe('datum resolve synthesis', () => {
  it('entityFor synthesizes datum views only when the model has datums', () => {
    const withDatums = model([lineView]);
    expect(entityFor(withDatums, { entity: -1 })?.kind).toBe('point');
    expect(entityFor(withDatums, { entity: -2 })?.kind).toBe('line');
    expect(refPoint(withDatums, { entity: -1 })).toEqual([0, 0]);
    const without = model([lineView], false);
    expect(entityFor(without, { entity: -1 })).toBeUndefined();
  });
});

describe('datumHitTest', () => {
  it('origin within the vertex threshold, axes within the edge threshold', () => {
    const m = model([]);
    expect(datumHitTest(m, [0.5, 0.5], 1, 0)?.datum).toBe('origin');
    expect(datumHitTest(m, [30, 0.5], 0, 1)?.datum).toBe('x-axis');
    expect(datumHitTest(m, [0.5, 30], 0, 1)?.datum).toBe('y-axis');
    expect(datumHitTest(m, [30, 30], 1, 1)).toBeNull();
  });

  it('returns nothing without datums or thresholds', () => {
    expect(datumHitTest(model([], false), [0, 0], 5, 5)).toBeNull();
    expect(datumHitTest(model([]), [0.5, 0.5], 0, 0)).toBeNull();
  });

  it('picks the nearer axis near the origin corner', () => {
    const m = model([]);
    expect(datumHitTest(m, [10, 0.2], 0, 1)?.datum).toBe('x-axis');
    expect(datumHitTest(m, [0.2, 10], 0, 1)?.datum).toBe('y-axis');
  });
});

describe('datum snap & emission plumbing', () => {
  const plane: PlaneData = {
    origin: { x: 0, y: 0, z: 0 },
    xDirection: { x: 1, y: 0, z: 0 },
    yDirection: { x: 0, y: 1, z: 0 },
    normal: { x: 0, y: 0, z: 1 },
    center: { x: 0, y: 0, z: 0 },
  } as PlaneData;

  it('AxisSnapper zeroes the near coordinate and carries the datum ref', () => {
    const snapper = new AxisSnapper(plane);
    const onX = snapper.snap([25, 0.4], 1);
    expect(onX?.point2d).toEqual([25, 0]);
    expect(onX?.ref).toEqual({ datum: 'x-axis' });
    expect(onX?.snapType).toBe('vertex');
    const onY = snapper.snap([-0.4, 12], 1);
    expect(onY?.point2d).toEqual([0, 12]);
    expect(onY?.ref).toEqual({ datum: 'y-axis' });
    expect(snapper.snap([10, 10], 1)).toBeNull();
  });

  it('refTarget maps datum refs to datum emission targets', () => {
    expect(refTarget({ datum: 'origin' })).toEqual({ datum: 'origin' });
    expect(refTarget({ line: 7, role: 'end', featureType: 'line' }))
      .toEqual({ line: 7, role: 'end', featureType: 'line' });
  });
});
