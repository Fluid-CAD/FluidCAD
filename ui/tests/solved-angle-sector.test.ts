import { describe, it, expect } from 'vitest';
import {
  angleSectorAt,
  angleSectorFor,
  angleSectorSpec,
  angleSectorTargets,
} from '../src/interactive/solved-constraint-toolbar/angle-sector';
import type { SolvedPick } from '../src/interactive/sketch-hover-select-handler';
import type { SolvedEntityView, SolvedSketchModel } from '../src/sketch-solver-client/model';

const loc = (line: number) => ({ filePath: '/ws/m.fluid.js', line, column: 3 });

function entityView(entityId: number, fields: Partial<SolvedEntityView> & { kind: SolvedEntityView['kind'] }): SolvedEntityView {
  return { entityId, obj: { id: `obj-${entityId}` } as any, ...fields };
}

function makeModel(entities: [number, SolvedEntityView][]): SolvedSketchModel {
  return {
    sketch: {} as any,
    plane: {} as any,
    solver: null,
    hasDatums: true,
    entities: new Map(entities),
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
  };
}

// The FreeCAD-screenshot shape: two lines crossing at the origin, a rising
// at 36.87° (3-4-5), b falling at 143.13°. The sectors read 106.26° above
// and below, 73.74° left and right.
const pickA: SolvedPick = { entityId: 0, kind: 'line', sourceLocation: loc(5) };
const pickB: SolvedPick = { entityId: 1, kind: 'line', sourceLocation: loc(6) };
const crossing = makeModel([
  [0, entityView(0, { kind: 'line', start: [-4, -3], end: [4, 3] })],
  [1, entityView(1, { kind: 'line', start: [4, -3], end: [-4, 3] })],
]);

describe('angleSectorAt', () => {
  it('defaults to the sector between the start→end directions', () => {
    const s = angleSectorAt(crossing, pickA, pickB, null)!;
    expect(s).toMatchObject({ aRole: 'end', bRole: 'end', swap: false });
    expect(s.valueDeg).toBeCloseTo(106.26, 2);
    expect(s.at).toEqual([0, 0]);
    expect(s.startAngle).toBeCloseTo(Math.atan2(3, 4), 10);
  });

  it('picks the sector under the cursor — one per quadrant, FreeCAD-style', () => {
    const top = angleSectorAt(crossing, pickA, pickB, [0, 5])!;
    expect(top).toMatchObject({ aRole: 'end', bRole: 'end', swap: false });
    expect(top.valueDeg).toBeCloseTo(106.26, 2);

    const bottom = angleSectorAt(crossing, pickA, pickB, [0, -5])!;
    expect(bottom).toMatchObject({ aRole: 'start', bRole: 'start', swap: false });
    expect(bottom.valueDeg).toBeCloseTo(106.26, 2);

    const right = angleSectorAt(crossing, pickA, pickB, [5, 0])!;
    expect(right).toMatchObject({ aRole: 'end', bRole: 'start', swap: true });
    expect(right.valueDeg).toBeCloseTo(73.74, 2);

    const left = angleSectorAt(crossing, pickA, pickB, [-5, 0])!;
    expect(left).toMatchObject({ aRole: 'start', bRole: 'end', swap: true });
    expect(left.valueDeg).toBeCloseTo(73.74, 2);
  });

  it('adjacent sectors are supplementary; every value is positive and ≤ 180', () => {
    const top = angleSectorAt(crossing, pickA, pickB, [0, 5])!;
    const right = angleSectorAt(crossing, pickA, pickB, [5, 0])!;
    expect(top.valueDeg + right.valueDeg).toBeCloseTo(180, 2);
    for (const cursor of [[0, 5], [0, -5], [5, 0], [-5, 0]] as [number, number][]) {
      const s = angleSectorAt(crossing, pickA, pickB, cursor)!;
      expect(s.valueDeg).toBeGreaterThan(0);
      expect(s.valueDeg).toBeLessThanOrEqual(180);
      expect(s.sweep).toBeGreaterThan(0);
      expect(s.sweep).toBeLessThanOrEqual(Math.PI);
    }
  });

  it('the arc starts on the emitted FROM ray and sweeps counterclockwise into the sector', () => {
    // Bottom sector: both rays reversed, no swap — the arc starts on −da.
    const bottom = angleSectorAt(crossing, pickA, pickB, [0, -5])!;
    expect(bottom.startAngle).toBeCloseTo(Math.atan2(-3, -4), 10);
    // Right sector: swap puts −db first — the arc starts on −db.
    const right = angleSectorAt(crossing, pickA, pickB, [5, 0])!;
    expect(right.startAngle).toBeCloseTo(Math.atan2(-3, 4), 10);
  });

  it('a cursor on the intersection falls back to the default sector', () => {
    const s = angleSectorAt(crossing, pickA, pickB, [0, 0])!;
    expect(s).toMatchObject({ aRole: 'end', bRole: 'end' });
  });

  it('crossing segments carry no extension leaders and no tail stubs', () => {
    const s = angleSectorAt(crossing, pickA, pickB, [0, 5])!;
    expect(s.extensions).toEqual([]);
    expect(s.tails).toEqual([]);
  });

  it('a segment stopping short of the intersection carries a dashed extension, whatever the sector', () => {
    const short = makeModel([
      [0, entityView(0, { kind: 'line', start: [-4, -3], end: [-2, -1.5] })],
      [1, entityView(1, { kind: 'line', start: [4, -3], end: [-4, 3] })],
    ]);
    const s = angleSectorAt(short, pickA, pickB, [0, 5])!;
    expect(s.at![0]).toBeCloseTo(0, 9);
    expect(s.at![1]).toBeCloseTo(0, 9);
    expect(s.extensions).toHaveLength(1);
    expect(s.extensions[0][0]).toEqual([-2, -1.5]);
    expect(s.extensions[0][1][0]).toBeCloseTo(0, 9);
    expect(s.extensions[0][1][1]).toBeCloseTo(0, 9);
    // Quadrant choice never changes the extensions.
    const other = angleSectorAt(short, pickA, pickB, [5, 0])!;
    expect(other.extensions).toEqual(s.extensions);
    // The shortened line's boundary ray is bare in the top sector — a
    // tail stub along +da keeps the arc's end touching the leader.
    expect(s.tails).toHaveLength(1);
    expect(s.tails[0]).toBeCloseTo(Math.atan2(0.6, 0.8), 9);
  });

  it('near-parallel lines carry no intersection but still measure', () => {
    const parallel = makeModel([
      [0, entityView(0, { kind: 'line', start: [0, 0], end: [10, 0] })],
      [1, entityView(1, { kind: 'line', start: [10, 5], end: [0, 5] })],
    ]);
    const s = angleSectorAt(parallel, pickA, pickB, [5, 2])!;
    expect(s.at).toBeNull();
    expect(s.valueDeg).toBe(180);
  });
});

describe('angleSectorFor', () => {
  it('re-derives a locked sector from its roles against fresh geometry', () => {
    const s = angleSectorFor(crossing, pickA, pickB, 'start', 'start')!;
    expect(s).toMatchObject({ aRole: 'start', bRole: 'start', swap: false });
    expect(s.valueDeg).toBeCloseTo(106.26, 2);
  });

  it('returns null when an entity is gone', () => {
    const only = makeModel([[0, entityView(0, { kind: 'line', start: [0, 0], end: [1, 0] })]]);
    expect(angleSectorFor(only, pickA, pickB, 'end', 'end')).toBeNull();
  });
});

describe('angleSectorSpec / angleSectorTargets', () => {
  it('default sector: bare refs in pick order, radians value', () => {
    const s = angleSectorAt(crossing, pickA, pickB, [0, 5])!;
    expect(angleSectorSpec(pickA, pickB, s, 106.26)).toEqual({
      kind: 'angle', a: { entity: 0 }, b: { entity: 1 }, value: (106.26 * Math.PI) / 180,
    });
    expect(angleSectorTargets(pickA, pickB, s)).toEqual([pickA, pickB]);
  });

  it('swapped supplementary sector: reversed order, .start() orientation only where flipped', () => {
    const s = angleSectorAt(crossing, pickA, pickB, [5, 0])!;
    expect(angleSectorSpec(pickA, pickB, s, 73.74)).toEqual({
      kind: 'angle', a: { entity: 1, point: 'start' }, b: { entity: 0 }, value: (73.74 * Math.PI) / 180,
    });
    expect(angleSectorTargets(pickA, pickB, s)).toEqual([
      { ...pickB, role: 'start' },
      { ...pickA },
    ]);
  });

  it('both-reversed sector: pick order kept, both oriented at start', () => {
    const s = angleSectorAt(crossing, pickA, pickB, [0, -5])!;
    expect(angleSectorSpec(pickA, pickB, s, 106.26)).toEqual({
      kind: 'angle',
      a: { entity: 0, point: 'start' },
      b: { entity: 1, point: 'start' },
      value: (106.26 * Math.PI) / 180,
    });
    expect(angleSectorTargets(pickA, pickB, s)).toEqual([
      { ...pickA, role: 'start' },
      { ...pickB, role: 'start' },
    ]);
  });
});

describe('datum-safe role normalization', () => {
  // Marwan's bug: line falling at −34.71° dimensioned against the x axis.
  // Clicking the sector between the line's BODY and the −x ray needs both
  // directions reversed — but a datum axis has no orientation accessor, so
  // the axis's 'start' role used to be silently dropped at emission,
  // persisting the SUPPLEMENTARY sector's constraint (180° off). The solver
  // then flipped the line and drove an attached tangent circle's radius
  // negative. Negating BOTH directions names the same constraint, so the
  // pair flips to (end, end) — bare refs, no accessor needed.
  const X_AXIS = -2;
  const axisPickB: SolvedPick = { entityId: X_AXIS, kind: 'line', datum: 'x-axis' };
  const slanted = makeModel([
    [0, entityView(0, { kind: 'line', start: [15.13, 64.3], end: [93.05, 10.32] })],
    [X_AXIS, entityView(X_AXIS, { kind: 'line', start: [0, 0], end: [1, 0] })],
  ]);

  it('a both-start sector against a datum axis emits the bare vertical-opposite pair', () => {
    const s = angleSectorFor(slanted, pickA, axisPickB, 'start', 'start')!;
    expect(s.swap).toBe(false);
    expect(s.valueDeg).toBeCloseTo(34.71, 2);
    expect(angleSectorTargets(pickA, axisPickB, s)).toEqual([
      { ...pickA },
      { ...axisPickB },
    ]);
    expect(angleSectorSpec(pickA, axisPickB, s, s.valueDeg)).toEqual({
      kind: 'angle',
      a: { entity: 0 },
      b: { entity: X_AXIS },
      value: (s.valueDeg * Math.PI) / 180,
    });
  });

  it('a datum-start/line-end sector flips to datum-end/line-start', () => {
    // Supplementary sector: axis reversed, line forward — the flip moves
    // the accessor onto the line, where `.start()` exists.
    const s = angleSectorFor(slanted, pickA, axisPickB, 'end', 'start')!;
    expect(s.valueDeg).toBeCloseTo(145.29, 2);
    const targets = angleSectorTargets(pickA, axisPickB, s);
    expect(targets.some(t => t.datum !== undefined && t.role === 'start')).toBe(false);
    // The same sector re-derived from the flipped roles measures the same.
    const roles = targets.map(t => (t.role === 'start' ? 'start' : 'end'));
    const reFlipped = s.swap
      ? angleSectorFor(slanted, pickA, axisPickB, roles[1] as any, roles[0] as any)!
      : angleSectorFor(slanted, pickA, axisPickB, roles[0] as any, roles[1] as any)!;
    expect(reFlipped.valueDeg).toBeCloseTo(s.valueDeg, 2);
  });

  it('a start role on a non-datum line still emits as before', () => {
    const s = angleSectorAt(crossing, pickA, pickB, [0, -5])!;
    expect(angleSectorTargets(pickA, pickB, s)).toEqual([
      { ...pickA, role: 'start' },
      { ...pickB, role: 'start' },
    ]);
  });
});
