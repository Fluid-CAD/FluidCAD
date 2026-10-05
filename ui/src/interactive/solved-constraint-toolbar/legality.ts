// Pure legality + measurement for the solved constraint toolbar (P4). What a
// given ordered pick set can constrain, which dimension form a pick pair
// selects, and the measured seed value the value input opens with — all
// unit-testable, no DOM/Three.

import type { ConstraintSpec, SolverRef } from '../../../../lib/sketch-solver/types.js';
import type { SolvedPick } from '../sketch-hover-select-handler';
import type { ArrowEnds, SolvedConstraintView, SolvedSketchModel } from '../../sketch-solver-client';
import { diameterChord, distanceLeaderLayout } from '../../sketch-solver-client';
import {
  Vec2,
  entityAnchor,
  dist,
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
  /** Distances against a circle/arc may measure to the near (min,
   * default) or far (max) side of the circumference. */
  tangencyChoice: boolean;
};

/** A pick is a point when it names a vertex or IS a point entity. */
export function isPointPick(p: SolvedPick): boolean {
  return p.role !== undefined || p.kind === 'point';
}

/** Datum picks: the origin (a point) and the x/y axes (infinite lines). */
export function isDatumPick(p: SolvedPick): boolean {
  return p.datum !== undefined;
}

/** Fixed picks never move: datums and projected references (P6). A
 * constraint needs at least one free entity to act on. */
export function isFixedPick(p: SolvedPick): boolean {
  return p.datum !== undefined || p.reference !== undefined;
}

/** Do two point picks name the same solver point? Compares the entity and
 * the role — `l.start()` twice is one point, `l.start()` vs `l.end()` two. */
export function samePointPick(a: SolvedPick, b: SolvedPick): boolean {
  return a.entityId === b.entityId && (a.role ?? null) === (b.role ?? null);
}

function distinctPointPicks(picks: SolvedPick[]): boolean {
  return picks.every((p, i) => picks.slice(i + 1).every(q => !samePointPick(p, q)));
}

/**
 * Three point picks for the Midpoint button, reordered so the point that
 * gets constrained comes first: the one nearest the mean of the other two
 * (the user has usually roughed it in near the middle already), ties by
 * pick order. Pick order never matters on this toolbar — geometry decides.
 * Anything but three point picks passes through untouched.
 */
export function orderMidpointPicks(model: SolvedSketchModel, picks: SolvedPick[]): SolvedPick[] {
  if (picks.length !== 3 || !picks.every(isPointPick)) {
    return picks;
  }
  const at = picks.map(p => refPoint(model, pickRef(p)));
  if (at.some(v => v === null)) {
    return picks;
  }
  let best = 0;
  let bestErr = Infinity;
  for (let i = 0; i < 3; i++) {
    const others = at.filter((_, k) => k !== i) as Vec2[];
    const err = dist(at[i] as Vec2, mid(others[0], others[1]));
    if (err < bestErr - 1e-12) {
      best = i;
      bestErr = err;
    }
  }
  return [picks[best], ...picks.filter((_, k) => k !== best)];
}

function isAxisPick(p: SolvedPick): boolean {
  return p.datum === 'x-axis' || p.datum === 'y-axis';
}

function isEntityPick(p: SolvedPick, ...kinds: SolvedPick['kind'][]): boolean {
  return p.role === undefined && kinds.includes(p.kind);
}

function isRound(p: SolvedPick): boolean {
  return isEntityPick(p, 'circle', 'arc');
}

/** An ellipse entity pick: a curve with a center and a rotation, but no
 * single radius — so never `isRound` (the radius/diameter/distance forms
 * and equal have nothing to size on it). */
function isEllipse(p: SolvedPick): boolean {
  return isEntityPick(p, 'ellipse');
}

/** Any curve a point can sit on or a tangent can touch. */
function isCurve(p: SolvedPick): boolean {
  return isLine(p) || isRound(p) || isEllipse(p);
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
 * sees the point–point distance form the solver already owns. A datum
 * axis never expands — it is infinite and has no length. */
export function expandDimensionPicks(picks: SolvedPick[]): SolvedPick[] {
  if (picks.length === 1 && isLine(picks[0]) && !isAxisPick(picks[0])) {
    return [{ ...picks[0], role: 'start' }, { ...picks[0], role: 'end' }];
  }
  return picks;
}

/** Entity–entity distances measure b's midpoint to a's infinite line — a
 * datum axis has no meaningful midpoint, so it always takes the a slot
 * (symmetric in meaning for the parallel-lines dim; every other form is
 * order-agnostic). Mirrors the kernel statement layer's normalization so
 * measure/ghost/preview agree with the emitted statement. */
export function normalizeDistancePicks(picks: SolvedPick[]): SolvedPick[] {
  if (picks.length === 2 && isAxisPick(picks[1]) && isLine(picks[0]) && !isAxisPick(picks[0])) {
    return [picks[1], picks[0]];
  }
  return picks;
}

/** The point pair a horizontal/vertical distance measures, or null when the
 * picks have no axis form. Point picks pass through; a circle/arc pick
 * measures its CENTER (the arc-condition center default every mainstream
 * sketcher uses for axis dims — the solver's axis rows want point refs, and
 * the emission renders the `.center()` accessor). A line pick other than
 * the lone-line length expansion has no axis form — its distance is
 * perpendicular by definition. Callers gate on dimensionFormFor first. */
export function axisDimensionPicks(rawPicks: SolvedPick[]): [SolvedPick, SolvedPick] | null {
  const picks = expandDimensionPicks(rawPicks);
  if (picks.length !== 2) {
    return null;
  }
  const toPoint = (p: SolvedPick): SolvedPick | null =>
    isPointPick(p) ? p : isRound(p) ? { ...p, role: 'center' } : null;
  const a = toPoint(picks[0]);
  const b = toPoint(picks[1]);
  return a && b ? [a, b] : null;
}

/** Below this a measure rounds to 0 at the 2dp write-back precision. */
const ZERO_2DP = 0.005;

/** Which distance form the cursor's position picks during placement — the
 * classic smart-dimension regions around the measured point pair: within
 * the pair's x-range above/below → horizontal (Δx), within the y-range
 * beside → vertical (Δy), inside the box or in a diagonal corner →
 * aligned. An axis whose measure rounds to 0 (2dp — the write-back
 * precision) is never offered: a zero dimension is a conflict in waiting,
 * and the aligned form already IS that measurement. */
export function axisFromCursor(a: Vec2, b: Vec2, cursor: Vec2): 'x' | 'y' | undefined {
  const ZERO = ZERO_2DP;
  const inX = cursor[0] >= Math.min(a[0], b[0]) && cursor[0] <= Math.max(a[0], b[0]);
  const inY = cursor[1] >= Math.min(a[1], b[1]) && cursor[1] <= Math.max(a[1], b[1]);
  if (inX && !inY && Math.abs(b[0] - a[0]) >= ZERO) {
    return 'x';
  }
  if (inY && !inX && Math.abs(b[1] - a[1]) >= ZERO) {
    return 'y';
  }
  return undefined;
}

/** True when the placement stage has no real choice to offer: a pure point
 * pair that is already axis-aligned. The zero-measure axis is never
 * offered, and the surviving one measures exactly what the aligned form
 * measures — so the caller skips placement and opens the value input
 * directly on the aligned form. Round picks always place: their aligned
 * form measures to the CIRCUMFERENCE while the axis forms measure the
 * centers, a real choice even when the centers line up. */
export function distancePlacementMoot(rawPicks: SolvedPick[], a: Vec2, b: Vec2): boolean {
  return rawPicks.every(isPointPick)
    && (Math.abs(b[0] - a[0]) < ZERO_2DP || Math.abs(b[1] - a[1]) < ZERO_2DP);
}

const NEED = {
  coincident: 'pick two points, or a point and an entity',
  horizontal: 'pick a line, an ellipse, or two or more points',
  vertical: 'pick a line, an ellipse, or two or more points',
  parallel: 'pick two or more lines',
  perpendicular: 'pick two lines',
  tangent: 'pick a line and a circle/arc/ellipse, or two circles/arcs/ellipses',
  equal: 'pick two or more lines, or two or more circles/arcs',
  concentric: 'pick two circles/arcs/ellipses',
  collinear: 'pick two lines',
  midpoint: 'pick a point and a line, or three points',
  symmetric: 'pick two points, or two lines/arcs/circles/ellipses of one kind, then their mirror line',
  fix: 'pick one point',
  dimension: 'pick two points/entities, one line, one circle/arc, or one ellipse',
  angle: 'pick two lines',
} as const;

function pairEnabled(id: ConstraintButtonId, picks: SolvedPick[]): boolean {
  // Datums and projected references are fixed geometry: a constraint whose
  // every target is fixed has nothing to solve (the kernel refuses it too).
  if (picks.length > 0 && picks.every(isFixedPick)) {
    return false;
  }
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
        || (pa && isCurve(b) && a.entityId !== b.entityId)
        || (pb && isCurve(a) && a.entityId !== b.entityId);
    }
    case 'horizontal':
    case 'vertical':
      // An axis is already exactly horizontal or vertical — pointless
      // either way (redundant or a guaranteed conflict). A lone ellipse
      // orients its RX axis. The point form takes any number ≥ 2, all
      // aligned to the first.
      return (picks.length === 1 && (isLine(a) || isEllipse(a)) && !isAxisPick(a))
        || (picks.length >= 2 && picks.every(isPointPick));
    case 'parallel':
      // Any number of lines parallel to the first, all distinct.
      return picks.length >= 2
        && new Set(picks.map(p => p.entityId)).size === picks.length
        && picks.every(isLine);
    case 'perpendicular':
    case 'collinear':
    case 'angle':
      return picks.length === 2 && isLine(a) && isLine(b) && a.entityId !== b.entityId;
    case 'tangent':
      // Any two curves except two lines (collinear owns that).
      return picks.length === 2 && a.entityId !== b.entityId
        && isCurve(a) && isCurve(b) && !(isLine(a) && isLine(b));
    case 'equal':
      // Any number of entities equate to the first — all lines or all
      // circles/arcs, all distinct. A datum axis is infinite — it has no
      // length to equate.
      return picks.length >= 2
        && new Set(picks.map(p => p.entityId)).size === picks.length
        && picks.every(p => !isAxisPick(p))
        && (picks.every(isLine) || picks.every(isRound));
    case 'concentric':
      return picks.length === 2 && a.entityId !== b.entityId
        && (isRound(a) || isEllipse(a)) && (isRound(b) || isEllipse(b));
    case 'midpoint': {
      // Point-pair form: three distinct points, the first (after the
      // geometric reorder, see orderMidpointPicks) sits halfway between
      // the other two.
      if (picks.length === 3) {
        return picks.every(isPointPick) && distinctPointPicks(picks);
      }
      if (picks.length !== 2 || a.entityId === b.entityId) {
        return false;
      }
      // The carrier line's midpoint must exist — never a datum axis.
      const line = isPointPick(a) ? b : isPointPick(b) ? a : null;
      const point = line === b ? a : line === a ? b : null;
      return !!line && !!point && isPointPick(point) && isLine(line) && !isAxisPick(line);
    }
    case 'symmetric': {
      if (picks.length !== 3) {
        return false;
      }
      const points = picks.filter(isPointPick);
      if (points.length === 2) {
        return picks.filter(isLine).length === 1;
      }
      // Entity form: two drawn entities of one kind (lines, arcs, circles,
      // ellipses), then the mirror line — the LAST pick, since three lines
      // would otherwise be ambiguous.
      if (points.length !== 0) {
        return false;
      }
      const [first, second, line] = picks;
      return isLine(line)
        && first.role === undefined && second.role === undefined
        && first.kind === second.kind
        && (first.kind === 'line' || first.kind === 'arc' || first.kind === 'circle' || first.kind === 'ellipse')
        && !isAxisPick(first) && !isAxisPick(second)
        && first.entityId !== second.entityId
        && first.entityId !== line.entityId && second.entityId !== line.entityId;
    }
    case 'fix':
      return picks.length === 1 && isPointPick(a);
    case 'dimension':
      return dimensionFormFor(picks) !== null;
  }
}

/**
 * Which semi-radius a lone ellipse pick dimensions: the axis its touch lies
 * closer to in the ellipse's own frame (|x'|/rx vs |y'|/ry) — a click near
 * the end of the RX axis dimensions RX. Picks without a touch (vertex,
 * programmatic) read RX.
 */
export function ellipseRadiusAxis(model: SolvedSketchModel, pick: SolvedPick): 'x' | 'y' {
  const e = entityFor(model, pickRef(pick));
  if (!pick.at || !e || e.kind !== 'ellipse' || !e.center || !e.radii) {
    return 'x';
  }
  const c = Math.cos(e.theta ?? 0);
  const s = Math.sin(e.theta ?? 0);
  const dx = pick.at[0] - e.center[0];
  const dy = pick.at[1] - e.center[1];
  const xp = dx * c + dy * s;
  const yp = -dx * s + dy * c;
  return Math.abs(xp) / e.radii[0] >= Math.abs(yp) / e.radii[1] ? 'x' : 'y';
}

/**
 * The orientation an entity already carries: the single-entity
 * `horizontal(e)` / `vertical(e)` statements on a lone line or ellipse
 * pick. An entity has exactly one orientation, so a new H/V on it can
 * never stack — it either repeats what is there (`alreadyApplied`) or must
 * REPLACE the other kind (`replaced`), the way a drawn ellipse's inferred
 * `horizontal` gives way to a Vertical click instead of conflicting with
 * it. Null when the picks are not the single-entity form.
 */
export function orientationReplacement(
  model: SolvedSketchModel,
  id: 'horizontal' | 'vertical',
  picks: SolvedPick[],
): { alreadyApplied: SolvedConstraintView[]; replaced: SolvedConstraintView[] } | null {
  if (picks.length !== 1 || !(isLine(picks[0]) || isEllipse(picks[0])) || isFixedPick(picks[0])) {
    return null;
  }
  const entityId = picks[0].entityId;
  const alreadyApplied: SolvedConstraintView[] = [];
  const replaced: SolvedConstraintView[] = [];
  for (const c of model.constraints) {
    const spec = c.spec;
    if ((spec.kind !== 'horizontal' && spec.kind !== 'vertical') || spec.b !== undefined) {
      continue;
    }
    if (spec.a.entity !== entityId || spec.a.point !== undefined) {
      continue;
    }
    (spec.kind === id ? alreadyApplied : replaced).push(c);
  }
  return { alreadyApplied, replaced };
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
  // All-fixed measurements (datums, projected references) are constants —
  // nothing to dimension.
  if (picks.length > 0 && picks.every(isFixedPick)) {
    return null;
  }
  if (picks.length === 1) {
    const p = picks[0];
    if (isRound(p)) {
      return { kind: p.kind === 'circle' ? 'diameter' : 'radius', axisChoice: false, tangencyChoice: false };
    }
    if (isEllipse(p)) {
      // One semi-radius — which one the touch decides (ellipseRadiusAxis).
      return { kind: 'radius', axisChoice: false, tangencyChoice: false };
    }
    return null;
  }
  if (picks.length !== 2) {
    return null;
  }
  const [a, b] = picks;
  if (isPointPick(a) && isPointPick(b)) {
    return { kind: 'distance', axisChoice: true, tangencyChoice: false };
  }
  // Point–entity, but never a point against its OWN entity: a line's
  // endpoint is on the line (distance identically zero — the statement the
  // solver can only report as a conflict), and a circle/arc's own points
  // reduce to radius forms that radius()/diameter() already own.
  const point = isPointPick(a) ? a : isPointPick(b) ? b : null;
  const entity = point === a ? b : a;
  if (point && (isLine(entity) || isRound(entity)) && point.entityId !== entity.entityId) {
    // Round targets also offer the axis forms — measured to the CENTER
    // (axisDimensionPicks substitutes the role).
    return { kind: 'distance', axisChoice: isRound(entity), tangencyChoice: isRound(entity) };
  }
  // Entity–entity: line–line, circle–circle, and line–circle/arc (the
  // perpendicular gap to the circumference).
  if ((isLine(a) || isRound(a)) && (isLine(b) || isRound(b)) && a.entityId !== b.entityId) {
    return {
      kind: 'distance',
      axisChoice: isRound(a) && isRound(b),
      tangencyChoice: isRound(a) || isRound(b),
    };
  }
  return null;
}

/**
 * Which tangency side a dimension's picks imply, from the TOUCH on the
 * clicked circle/arc: a touch on the side of the circumference facing the
 * other target measures near (min, the default); the opposite side
 * measures far (max). Picks without a touch point (vertex picks,
 * programmatic selection) read min. The timeline row's "Use min/max
 * tangent" flips a committed statement.
 */
export function inferTangency(
  model: SolvedSketchModel,
  rawPicks: SolvedPick[],
  form: DimensionForm,
): 'min' | 'max' {
  if (form.kind !== 'distance' || !form.tangencyChoice) {
    return 'min';
  }
  const picks = expandDimensionPicks(rawPicks);
  if (picks.length !== 2) {
    return 'min';
  }
  // The freshest round touch decides — the later click carries the intent.
  for (let i = picks.length - 1; i >= 0; i--) {
    const p = picks[i];
    if (!isRound(p) || !p.at) {
      continue;
    }
    const e = entityFor(model, pickRef(p));
    if (!e?.center) {
      continue;
    }
    const anchor = towardAnchor(model, picks[1 - i], e.center);
    if (!anchor) {
      continue;
    }
    const touch = sub(p.at, e.center);
    const toward = sub(anchor, e.center);
    return touch[0] * toward[0] + touch[1] * toward[1] >= 0 ? 'min' : 'max';
  }
  return 'min';
}

/** The point the distance measures toward, for the touch-side test: the
 * other pick's vertex, the circle center's foot on the other line, or the
 * other circle's center. */
function towardAnchor(model: SolvedSketchModel, other: SolvedPick, center: Vec2): Vec2 | null {
  if (isPointPick(other)) {
    return refPoint(model, pickRef(other));
  }
  const e = entityFor(model, pickRef(other));
  if (!e) {
    return null;
  }
  if (e.kind === 'line') {
    return footOnLine(e, center);
  }
  return e.center ?? null;
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
  tangency?: 'min' | 'max',
): number | null {
  const picks = normalizeDistancePicks(expandDimensionPicks(rawPicks));
  const round2 = (v: number): number => Math.round(v * 100) / 100;
  const far = tangency === 'max';

  if (form.kind === 'radius' || form.kind === 'diameter') {
    const e = entityFor(model, pickRef(picks[0]));
    if (e?.kind === 'ellipse' && e.radii) {
      return round2(axis === 'y' ? e.radii[1] : e.radii[0]);
    }
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
      const d = norm(sub(point, e.center));
      return round2(far ? d + e.radius : Math.abs(d - e.radius));
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
      if (!foot) {
        return null;
      }
      const d = norm(sub(roundE.center, foot));
      return round2(far ? d + roundE.radius : Math.abs(d - roundE.radius));
    }
    if (ea.center && eb.center && ea.radius !== undefined && eb.radius !== undefined) {
      const d = norm(sub(eb.center, ea.center));
      return round2(far
        ? d + ea.radius + eb.radius
        : Math.abs(d - ea.radius - eb.radius));
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
  tangency?: 'min' | 'max',
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
        : {
            kind: id, a: pickRef(a), b: pickRef(b),
            ...(picks.length > 2 ? { others: picks.slice(2).map(pickRef) } : {}),
          };
    case 'perpendicular':
    case 'tangent':
    case 'concentric':
    case 'collinear':
      return { kind: id, a: pickRef(a), b: pickRef(b) };
    case 'parallel':
    case 'equal':
      // Everything after the first pick equates/parallels to it.
      return {
        kind: id, a: pickRef(a), b: pickRef(b),
        ...(picks.length > 2 ? { others: picks.slice(2).map(pickRef) } : {}),
      };
    case 'midpoint': {
      if (picks.length === 3) {
        // Callers hand picks through orderMidpointPicks first: picks[0]
        // is the constrained point.
        return { kind: 'midpoint', p: pickRef(a), a: pickRef(b), b: pickRef(picks[2]) };
      }
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
        return isEllipse(a)
          ? { kind: 'radius', a: pickRef(a), value, axis: axis ?? 'x' }
          : { kind: 'radius', a: pickRef(a), value };
      }
      if (form.kind === 'diameter') {
        return { kind: 'diameter', a: pickRef(a), value };
      }
      const [da, db] = normalizeDistancePicks(expandDimensionPicks(picks));
      const spec: ConstraintSpec = { kind: 'distance', a: pickRef(da), b: pickRef(db), value };
      if (axis !== undefined) {
        (spec as { axis?: 'x' | 'y' }).axis = axis;
      }
      if (tangency === 'max' && form.tangencyChoice) {
        (spec as { tangency?: 'min' | 'max' }).tangency = 'max';
      }
      return spec;
    }
  }
}

export type DimensionPreviewLayout = {
  /** Leader endpoints in sketch coords; null = no leader (angle). */
  line: [Vec2, Vec2] | null;
  /** Dashed witness leaders from a synthetic leader end to the real
   * anchor (axis forms — the committed glyph draws the same). */
  extensions?: [Vec2, Vec2][];
  /** Arrowheads on the leader's ends — set the way the committed glyph
   * sets them, so the preview is the same line. */
  arrows?: ArrowEnds;
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
 * the committed glyph's leader uses (distanceLeaderLayout — the preview
 * lands exactly where the real dimension will render), with the value
 * input anchored at the label position. Angles preview the given sector
 * (default: between the start→end directions). */
export function dimensionPreviewLayout(
  model: SolvedSketchModel,
  rawPicks: SolvedPick[],
  form: DimensionForm,
  axis?: 'x' | 'y',
  sector?: AngleSector | null,
  tangency?: 'min' | 'max',
): DimensionPreviewLayout | null {
  const picks = normalizeDistancePicks(expandDimensionPicks(rawPicks));
  if (form.kind === 'radius' || form.kind === 'diameter') {
    const e = entityFor(model, pickRef(picks[0]));
    if (!e || !e.center) {
      return null;
    }
    if (e.kind === 'ellipse' && e.radii) {
      // Center → the end of the dimensioned semi-axis, riding the line.
      const c = Math.cos(e.theta ?? 0);
      const s = Math.sin(e.theta ?? 0);
      const end: Vec2 = axis === 'y'
        ? [e.center[0] - e.radii[1] * s, e.center[1] + e.radii[1] * c]
        : [e.center[0] + e.radii[0] * c, e.center[1] + e.radii[0] * s];
      return { line: [e.center, end], at: mid(e.center, end), arrows: 'end' };
    }
    if (form.kind === 'diameter') {
      // Rim to rim through the center — the chord the committed glyph will
      // draw, with the value input opening on its label spot.
      const chord = diameterChord(model, e);
      return chord ? { line: chord, at: mid(chord[0], chord[1]), arrows: 'both' } : null;
    }
    const rim = entityAnchor(e);
    // Rim end only — the center end of a radius leader measures nothing.
    // The input opens where the committed label lands: halfway along the
    // radius, riding the line.
    return rim
      ? { line: [e.center, rim], at: mid(e.center, rim), arrows: 'end' }
      : null;
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
  if (tangency === 'max' && form.tangencyChoice) {
    spec.tangency = 'max';
  }
  const layout = distanceLeaderLayout(model, spec);
  if (!layout) {
    return null;
  }
  return {
    line: [layout.from, layout.to],
    at: mid(layout.from, layout.to),
    arrows: 'both',
    ...(layout.extensions.length > 0 ? { extensions: layout.extensions } : {}),
  };
}

// -- coincident removal from a vertex pick ------------------------------------
//
// Point–point coincidents draw as a ring ON the shared vertex, and that ring
// is deliberately not a pick target (P4: ring priority starved vertex drags
// and the two-pick flow). Picking the VERTEX stands in for picking the ring:
// the constraint bar's Delete then removes the coincidents bound to that
// point — every one of them at a junction of three or more segments, since
// the vertices there overlap and only one of them can ever be clicked.

function sameRef(a: SolverRef, b: SolverRef): boolean {
  return a.entity === b.entity && (a.point ?? null) === (b.point ?? null);
}

/** A point–point coincident: both refs resolve to points (the point-on
 * form has its own pickable `⊙` badge and is not handled here). */
function isRingCoincident(model: SolvedSketchModel, c: SolvedConstraintView): boolean {
  return c.spec.kind === 'coincident'
    && refPoint(model, c.spec.a) !== null
    && refPoint(model, c.spec.b) !== null;
}

/**
 * The point–point coincidents a vertex pick stands for: with ONE point
 * pick, every coincident binding that point; with TWO point picks, the
 * coincident binding exactly those two. Any other pick set (edges, three
 * or more points, nothing) names no coincident. Model order is kept, so
 * the first entry is the ring the glyph layout actually drew.
 */
export function coincidentsAtPicks(model: SolvedSketchModel, picks: SolvedPick[]): SolvedConstraintView[] {
  if (picks.length === 0 || picks.length > 2 || !picks.every(isPointPick)) {
    return [];
  }
  const refs = picks.map(pickRef);
  return model.constraints.filter((c) => {
    if (!isRingCoincident(model, c)) {
      return false;
    }
    const { a, b } = c.spec as Extract<ConstraintSpec, { kind: 'coincident' }>;
    if (refs.length === 1) {
      return sameRef(a, refs[0]) || sameRef(b, refs[0]);
    }
    return (sameRef(a, refs[0]) && sameRef(b, refs[1]))
      || (sameRef(a, refs[1]) && sameRef(b, refs[0]));
  });
}

/**
 * Every ring coincident drawn at the same spot as one of `targets`. The
 * glyph layout collapses identical rings into ONE drawn dot carrying the
 * first statement's id, so tinting "the ring of this coincident" means
 * tinting whichever statement owns the dot at that position.
 */
export function coincidentRingIds(model: SolvedSketchModel, targets: SolvedConstraintView[]): string[] {
  const spots: Vec2[] = [];
  for (const c of targets) {
    const spec = c.spec as Extract<ConstraintSpec, { kind: 'coincident' }>;
    const pa = refPoint(model, spec.a);
    const pb = refPoint(model, spec.b);
    if (pa && pb) {
      spots.push(mid(pa, pb));
    }
  }
  const ids: string[] = [];
  for (const c of model.constraints) {
    if (!isRingCoincident(model, c) || c.obj.id === undefined) {
      continue;
    }
    const spec = c.spec as Extract<ConstraintSpec, { kind: 'coincident' }>;
    const at = mid(refPoint(model, spec.a) as Vec2, refPoint(model, spec.b) as Vec2);
    if (spots.some(s => Math.abs(s[0] - at[0]) < 5e-4 && Math.abs(s[1] - at[1]) < 5e-4)) {
      ids.push(c.obj.id);
    }
  }
  return ids;
}

/** One ref as the Delete tooltip names it: `line end`, `arc start`,
 * `circle center`, `point`, `origin`. */
function describeRef(model: SolvedSketchModel, ref: SolverRef): string {
  if (ref.entity < 0) {
    return 'origin';
  }
  const e = entityFor(model, ref);
  const kind = e?.kind ?? 'point';
  return ref.point ? `${kind} ${ref.point}` : kind;
}

/** The Delete button's tooltip for a vertex-derived coincident set:
 * `Delete coincident (line end · arc start)`, or a count when a junction
 * holds several. Null when there is nothing to delete. */
export function describeCoincidentRemoval(
  model: SolvedSketchModel,
  targets: SolvedConstraintView[],
): string | null {
  if (targets.length === 0) {
    return null;
  }
  if (targets.length > 1) {
    return `Delete ${targets.length} coincidents at this point`;
  }
  const spec = targets[0].spec as Extract<ConstraintSpec, { kind: 'coincident' }>;
  return `Delete coincident (${describeRef(model, spec.a)} · ${describeRef(model, spec.b)})`;
}
