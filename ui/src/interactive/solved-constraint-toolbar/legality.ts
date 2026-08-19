// Pure legality + measurement for the solved constraint toolbar (P4). What a
// given ordered pick set can constrain, which dimension form a pick pair
// selects, and the measured seed value the value input opens with — all
// unit-testable, no DOM/Three.

import type { ConstraintSpec, SolverRef } from '../../../../lib/sketch-solver/types.js';
import type { SolvedPick } from '../sketch-hover-select-handler';
import type { SolvedSketchModel } from '../../sketch-solver-client';
import {
  entityFor,
  footOnLine,
  lineDir,
  lineMid,
  norm,
  refPoint,
  sub,
} from '../../sketch-solver-client/resolve';

export type ConstraintButtonId =
  | 'coincident' | 'horizontal' | 'vertical' | 'parallel' | 'perpendicular'
  | 'tangent' | 'equal' | 'concentric' | 'collinear' | 'midpoint'
  | 'symmetric' | 'fix' | 'dimension' | 'angle';

export type ConstraintOption = {
  id: ConstraintButtonId;
  enabled: boolean;
  reason?: string;
};

export type DimensionForm = {
  kind: 'distance' | 'angle' | 'radius' | 'diameter';
  /** Point–point distances may measure along one axis. */
  axisChoice: boolean;
};

/** A pick is a point when it names a vertex or IS a point entity. */
export function isPointPick(p: SolvedPick): boolean {
  return p.role !== undefined || p.kind === 'point';
}

function isEntityPick(p: SolvedPick, ...kinds: SolvedPick['kind'][]): boolean {
  return p.role === undefined && kinds.includes(p.kind);
}

function isRound(p: SolvedPick): boolean {
  return isEntityPick(p, 'circle', 'arc');
}

function isLine(p: SolvedPick): boolean {
  return isEntityPick(p, 'line');
}

/** Solver ref of one pick. */
export function pickRef(p: SolvedPick): SolverRef {
  if (p.role === undefined || p.role === null) {
    return { entity: p.entityId };
  }
  return { entity: p.entityId, point: p.role };
}

const NEED = {
  coincident: 'pick two points, or a point and an entity',
  horizontal: 'pick a line, or two points',
  vertical: 'pick a line, or two points',
  parallel: 'pick two lines',
  perpendicular: 'pick two lines',
  tangent: 'pick a line and a circle/arc, or two circles/arcs',
  equal: 'pick two lines or two circles/arcs',
  concentric: 'pick two circles/arcs',
  collinear: 'pick two lines',
  midpoint: 'pick a point and a line',
  symmetric: 'pick two points and their mirror line',
  fix: 'pick one point',
  dimension: 'pick two points/entities, or one circle/arc',
  angle: 'pick two lines',
} as const;

function pairEnabled(id: ConstraintButtonId, picks: SolvedPick[]): boolean {
  const [a, b] = picks;
  switch (id) {
    case 'coincident': {
      if (picks.length !== 2) {
        return false;
      }
      const pa = isPointPick(a);
      const pb = isPointPick(b);
      return (pa && pb)
        || (pa && (isLine(b) || isRound(b)))
        || (pb && (isLine(a) || isRound(a)));
    }
    case 'horizontal':
    case 'vertical':
      return (picks.length === 1 && isLine(a))
        || (picks.length === 2 && isPointPick(a) && isPointPick(b));
    case 'parallel':
    case 'perpendicular':
    case 'collinear':
    case 'angle':
      return picks.length === 2 && isLine(a) && isLine(b) && a.entityId !== b.entityId;
    case 'tangent':
      return picks.length === 2 && a.entityId !== b.entityId
        && ((isLine(a) && isRound(b)) || (isRound(a) && isLine(b)) || (isRound(a) && isRound(b)));
    case 'equal':
      return picks.length === 2 && a.entityId !== b.entityId
        && ((isLine(a) && isLine(b)) || (isRound(a) && isRound(b)));
    case 'concentric':
      return picks.length === 2 && isRound(a) && isRound(b) && a.entityId !== b.entityId;
    case 'midpoint':
      return picks.length === 2
        && ((isPointPick(a) && isLine(b)) || (isPointPick(b) && isLine(a)));
    case 'symmetric':
      return picks.length === 3
        && picks.filter(isPointPick).length === 2
        && picks.filter(isLine).length === 1;
    case 'fix':
      return picks.length === 1 && isPointPick(a);
    case 'dimension':
      return dimensionFormFor(picks) !== null;
  }
}

export function constraintOptions(picks: SolvedPick[]): ConstraintOption[] {
  return (Object.keys(NEED) as ConstraintButtonId[]).map((id) => {
    const enabled = pairEnabled(id, picks);
    return enabled ? { id, enabled } : { id, enabled, reason: NEED[id] };
  });
}

/** Which dimension a pick set selects (the two-pick flow, locked plan §0.4):
 * point–point / point–entity / entity–entity → distance, single circle →
 * diameter, single arc → radius. Angle has its own button. */
export function dimensionFormFor(picks: SolvedPick[]): DimensionForm | null {
  if (picks.length === 1) {
    const p = picks[0];
    if (isRound(p)) {
      return { kind: p.kind === 'circle' ? 'diameter' : 'radius', axisChoice: false };
    }
    return null;
  }
  if (picks.length !== 2) {
    return null;
  }
  const [a, b] = picks;
  if (isPointPick(a) && isPointPick(b)) {
    return { kind: 'distance', axisChoice: true };
  }
  const point = isPointPick(a) ? a : isPointPick(b) ? b : null;
  const entity = point === a ? b : a;
  if (point && (isLine(entity) || isRound(entity))) {
    return { kind: 'distance', axisChoice: false };
  }
  if (((isLine(a) && isLine(b)) || (isRound(a) && isRound(b))) && a.entityId !== b.entityId) {
    return { kind: 'distance', axisChoice: false };
  }
  return null;
}

/** Measured value of the dimension a pick set would create — the value
 * input's opening seed, in display units (degrees for angle). */
export function measureDimension(
  model: SolvedSketchModel,
  picks: SolvedPick[],
  form: DimensionForm,
  axis?: 'x' | 'y',
): number | null {
  const round2 = (v: number): number => Math.round(v * 100) / 100;

  if (form.kind === 'radius' || form.kind === 'diameter') {
    const e = entityFor(model, pickRef(picks[0]));
    if (!e || e.radius === undefined) {
      return null;
    }
    return round2(form.kind === 'radius' ? e.radius : e.radius * 2);
  }

  if (form.kind === 'angle') {
    const a = entityFor(model, pickRef(picks[0]));
    const b = entityFor(model, pickRef(picks[1]));
    const da = a ? lineDir(a) : null;
    const db = b ? lineDir(b) : null;
    if (!da || !db) {
      return null;
    }
    let deg = (Math.atan2(db[1], db[0]) - Math.atan2(da[1], da[0])) * (180 / Math.PI);
    if (deg <= -180) {
      deg += 360;
    }
    if (deg > 180) {
      deg -= 360;
    }
    return round2(deg);
  }

  const [a, b] = picks;
  const pa = isPointPick(a) ? refPoint(model, pickRef(a)) : null;
  const pb = isPointPick(b) ? refPoint(model, pickRef(b)) : null;
  if (pa && pb) {
    if (axis === 'x') {
      return round2(Math.abs(pb[0] - pa[0]));
    }
    if (axis === 'y') {
      return round2(Math.abs(pb[1] - pa[1]));
    }
    return round2(norm(sub(pb, pa)));
  }
  const point = pa ?? pb;
  const entityPick = pa ? b : a;
  const e = entityFor(model, pickRef(entityPick));
  if (point && e) {
    if (e.kind === 'line') {
      const foot = footOnLine(e, point);
      return foot ? round2(norm(sub(point, foot))) : null;
    }
    if (e.center && e.radius !== undefined) {
      return round2(Math.abs(norm(sub(point, e.center)) - e.radius));
    }
  }
  const ea = entityFor(model, pickRef(a));
  const eb = entityFor(model, pickRef(b));
  if (ea && eb) {
    if (ea.kind === 'line' && eb.kind === 'line') {
      const from = lineMid(eb);
      const foot = from ? footOnLine(ea, from) : null;
      return from && foot ? round2(norm(sub(from, foot))) : null;
    }
    if (ea.center && eb.center && ea.radius !== undefined && eb.radius !== undefined) {
      return round2(Math.abs(norm(sub(eb.center, ea.center)) - ea.radius - eb.radius));
    }
  }
  return null;
}

/** Client-side solver spec for a candidate constraint — the live ghost
 * preview solves with this before anything is written (P4). Returns null
 * when the picks don't form the kind. */
export function candidateSpec(
  id: ConstraintButtonId,
  picks: SolvedPick[],
  value?: number,
  axis?: 'x' | 'y',
): ConstraintSpec | null {
  if (!pairEnabled(id, picks)) {
    return null;
  }
  const [a, b] = picks;
  switch (id) {
    case 'coincident':
      return { kind: 'coincident', a: pickRef(a), b: pickRef(b) };
    case 'horizontal':
    case 'vertical':
      return picks.length === 1
        ? { kind: id, a: pickRef(a) }
        : { kind: id, a: pickRef(a), b: pickRef(b) };
    case 'parallel':
    case 'perpendicular':
    case 'tangent':
    case 'equal':
    case 'concentric':
    case 'collinear':
      return { kind: id, a: pickRef(a), b: pickRef(b) };
    case 'midpoint': {
      const point = isPointPick(a) ? a : b;
      const line = point === a ? b : a;
      return { kind: 'midpoint', p: pickRef(point), l: pickRef(line) };
    }
    case 'symmetric': {
      const points = picks.filter(isPointPick);
      const line = picks.find(isLine)!;
      return { kind: 'symmetric', a: pickRef(points[0]), b: pickRef(points[1]), l: pickRef(line) };
    }
    case 'fix':
      return { kind: 'fix', p: pickRef(a) };
    case 'angle':
      return value === undefined
        ? null
        : { kind: 'angle', a: pickRef(a), b: pickRef(b), value: (value * Math.PI) / 180 };
    case 'dimension': {
      const form = dimensionFormFor(picks);
      if (!form || value === undefined) {
        return null;
      }
      if (form.kind === 'radius') {
        return { kind: 'radius', a: pickRef(a), value };
      }
      if (form.kind === 'diameter') {
        return { kind: 'diameter', a: pickRef(a), value };
      }
      const spec: ConstraintSpec = { kind: 'distance', a: pickRef(a), b: pickRef(b), value };
      if (axis !== undefined) {
        (spec as { axis?: 'x' | 'y' }).axis = axis;
      }
      return spec;
    }
  }
}
