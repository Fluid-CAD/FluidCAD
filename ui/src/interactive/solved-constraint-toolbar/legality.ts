// Pure legality + measurement for the solved constraint toolbar (P4). What a
// given ordered pick set can constrain, which dimension form a pick pair
// selects, and the measured seed value the value input opens with — all
// unit-testable, no DOM/Three.

import type { ConstraintSpec, SolverRef } from '../../../../lib/sketch-solver/types.js';
import type { SolvedPick } from '../sketch-hover-select-handler';
import type { ArrowEnds, SolvedSketchModel } from '../../sketch-solver-client';
import { diameterChord, distanceLeaderLayout } from '../../sketch-solver-client';
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

function isAxisPick(p: SolvedPick): boolean {
  return p.datum === 'x-axis' || p.datum === 'y-axis';
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
        || (pa && (isLine(b) || isRound(b)) && a.entityId !== b.entityId)
        || (pb && (isLine(a) || isRound(a)) && a.entityId !== b.entityId);
    }
    case 'horizontal':
    case 'vertical':
      // An axis is already exactly horizontal or vertical — pointless
      // either way (redundant or a guaranteed conflict).
      return (picks.length === 1 && isLine(a) && !isAxisPick(a))
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
      // A datum axis is infinite — it has no length to equate.
      return picks.length === 2 && a.entityId !== b.entityId
        && !isAxisPick(a) && !isAxisPick(b)
        && ((isLine(a) && isLine(b)) || (isRound(a) && isRound(b)));
    case 'concentric':
      return picks.length === 2 && isRound(a) && isRound(b) && a.entityId !== b.entityId;
    case 'midpoint': {
      if (picks.length !== 2 || a.entityId === b.entityId) {
        return false;
      }
      // The carrier line's midpoint must exist — never a datum axis.
      const line = isPointPick(a) ? b : isPointPick(b) ? a : null;
      const point = line === b ? a : line === a ? b : null;
      return !!line && !!point && isPointPick(point) && isLine(line) && !isAxisPick(line);
    }
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
