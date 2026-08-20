// Pure legality + measurement for the solved constraint toolbar (P4). What a
// given ordered pick set can constrain, which dimension form a pick pair
// selects, and the measured seed value the value input opens with — all
// unit-testable, no DOM/Three.

import type { ConstraintSpec, SolverRef } from '../../../../lib/sketch-solver/types.js';
import type { SolvedPick } from '../sketch-hover-select-handler';
import type { SolvedSketchModel } from '../../sketch-solver-client';
import { distanceSpecEndpoints } from '../../sketch-solver-client';
import {
  Vec2,
  entityAnchor,
  entityFor,
  footOnLine,
  lineMid,
  mid,
  norm,
  refPoint,
  sub,
} from '../../sketch-solver-client/resolve';
import { AngleSector, angleSectorAt, angleSectorFor, angleSectorSpec } from './angle-sector';

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

/** A lone line pick dimensions its own length: expand it to the line's
 * endpoint pair so every consumer (form, measure, ghost spec, emission)
 * sees the point–point distance form the solver already owns. */
export function expandDimensionPicks(picks: SolvedPick[]): SolvedPick[] {
  if (picks.length === 1 && isLine(picks[0])) {
    return [{ ...picks[0], role: 'start' }, { ...picks[0], role: 'end' }];
  }
  return picks;
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
  dimension: 'pick two points/entities, one line, or one circle/arc',
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
      // Point-on-entity is degenerate when the point belongs to that entity
      // (a line's own endpoint is on the line by construction).
      return (pa && pb)
        || (pa && (isLine(b) || isRound(b)) && a.entityId !== b.entityId)
        || (pb && (isLine(a) || isRound(a)) && a.entityId !== b.entityId);
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
      return picks.length === 2 && a.entityId !== b.entityId
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
 * diameter, single arc → radius, single line → its length (the endpoint
 * pair). Angle has its own button. */
export function dimensionFormFor(rawPicks: SolvedPick[]): DimensionForm | null {
  const picks = expandDimensionPicks(rawPicks);
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
  // Point–entity, but never a point against its OWN entity: a line's
  // endpoint is on the line (distance identically zero — the statement the
  // solver can only report as a conflict), and a circle/arc's own points
  // reduce to radius forms that radius()/diameter() already own.
  const point = isPointPick(a) ? a : isPointPick(b) ? b : null;
  const entity = point === a ? b : a;
  if (point && (isLine(entity) || isRound(entity)) && point.entityId !== entity.entityId) {
    return { kind: 'distance', axisChoice: false };
  }
  // Entity–entity: line–line, circle–circle, and line–circle/arc (the
  // perpendicular gap to the circumference).
  if ((isLine(a) || isRound(a)) && (isLine(b) || isRound(b)) && a.entityId !== b.entityId) {
    return { kind: 'distance', axisChoice: false };
  }
  return null;
}

/** Measured value of the dimension a pick set would create — the value
 * input's opening seed, in display units (degrees for angle). Angles
 * measure a SECTOR (always positive, ≤ 180°): the given one, or the
 * default sector between the two start→end directions. */
export function measureDimension(
  model: SolvedSketchModel,
  rawPicks: SolvedPick[],
  form: DimensionForm,
  axis?: 'x' | 'y',
  sector?: AngleSector | null,
): number | null {
  const picks = expandDimensionPicks(rawPicks);
  const round2 = (v: number): number => Math.round(v * 100) / 100;

  if (form.kind === 'radius' || form.kind === 'diameter') {
    const e = entityFor(model, pickRef(picks[0]));
    if (!e || e.radius === undefined) {
      return null;
    }
    return round2(form.kind === 'radius' ? e.radius : e.radius * 2);
  }

  if (form.kind === 'angle') {
    const s = sector
      ? angleSectorFor(model, picks[0], picks[1], sector.aRole, sector.bRole)
      : angleSectorAt(model, picks[0], picks[1], null);
    return s ? s.valueDeg : null;
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
    const lineE = ea.kind === 'line' ? ea : eb.kind === 'line' ? eb : null;
    const roundE = lineE === ea ? eb : ea;
    if (lineE && roundE.center && roundE.radius !== undefined) {
      const foot = footOnLine(lineE, roundE.center);
      return foot ? round2(Math.abs(norm(sub(roundE.center, foot)) - roundE.radius)) : null;
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
  sector?: AngleSector | null,
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
    case 'angle': {
      if (value === undefined || !sector) {
        return null;
      }
      // The sector orders the refs and orients each line so the
      // counterclockwise value is the sector's own — always positive.
      return angleSectorSpec(a, b, sector, value);
    }
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
      const [da, db] = expandDimensionPicks(picks);
      const spec: ConstraintSpec = { kind: 'distance', a: pickRef(da), b: pickRef(db), value };
      if (axis !== undefined) {
        (spec as { axis?: 'x' | 'y' }).axis = axis;
      }
      return spec;
    }
  }
}

export type DimensionPreviewLayout = {
  /** Leader endpoints in sketch coords; null = no leader (angle). */
  line: [Vec2, Vec2] | null;
  /** Where the value input anchors — the committed glyph's label spot. */
  at: Vec2;
  /** Angle only: the sector arc around `at` (screen-constant radius, same
   * as the committed glyph), plus dashed extension leaders for segments
   * that don't reach the intersection and the tail-stub ray angles that
   * make the arc's ends touch them. Absent for near-parallel lines. */
  arc?: {
    startAngle: number;
    sweep: number;
    extensions: [Vec2, Vec2][];
    tails: number[];
  };
};

/** Where the dimension a pick set would create will sit: the same anchors
 * the committed glyph's leader uses (distanceSpecEndpoints — the preview
 * lands exactly where the real dimension will render), with the value
 * input anchored at the label position. Angles preview the given sector
 * (default: between the start→end directions). */
export function dimensionPreviewLayout(
  model: SolvedSketchModel,
  rawPicks: SolvedPick[],
  form: DimensionForm,
  axis?: 'x' | 'y',
  sector?: AngleSector | null,
): DimensionPreviewLayout | null {
  const picks = expandDimensionPicks(rawPicks);
  if (form.kind === 'radius' || form.kind === 'diameter') {
    const e = entityFor(model, pickRef(picks[0]));
    const rim = e?.center ? entityAnchor(e) : null;
    return e?.center && rim ? { line: [e.center, rim], at: rim } : null;
  }
  if (form.kind === 'angle') {
    if (!picks[1]) {
      return null;
    }
    const s = sector
      ? angleSectorFor(model, picks[0], picks[1], sector.aRole, sector.bRole)
      : angleSectorAt(model, picks[0], picks[1], null);
    if (!s) {
      return null;
    }
    if (s.at) {
      return {
        line: null,
        at: s.at,
        arc: {
          startAngle: s.startAngle,
          sweep: s.sweep,
          extensions: s.extensions,
          tails: s.tails,
        },
      };
    }
    // Near-parallel lines have no usable intersection — anchor between
    // the two midpoints, like the committed glyph's fallback readout.
    const a = entityFor(model, pickRef(picks[0]));
    const b = entityFor(model, pickRef(picks[1]));
    const ma = a ? lineMid(a) : null;
    const mb = b ? lineMid(b) : null;
    return ma && mb ? { line: null, at: mid(ma, mb) } : null;
  }
  if (picks.length !== 2) {
    return null;
  }
  const spec: Extract<ConstraintSpec, { kind: 'distance' }> = {
    kind: 'distance', a: pickRef(picks[0]), b: pickRef(picks[1]), value: 0,
  };
  if (axis !== undefined) {
    spec.axis = axis;
  }
  const endpoints = distanceSpecEndpoints(model, spec);
  return endpoints ? { line: endpoints, at: mid(endpoints[0], endpoints[1]) } : null;
}
