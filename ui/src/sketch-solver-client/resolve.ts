// Sketch-local 2D resolution of solver refs against the read model:
// where a constraint's members live, so glyph layout can anchor badges,
// leaders and dimension text. All math is in sketch-plane coordinates;
// mesh building converts to world via the sketch plane.

import type { SolverRef } from '../../../lib/sketch-solver/types.js';
import type { SolvedEntityView, SolvedSketchModel } from './model';

export type Vec2 = [number, number];

export function sub(a: Vec2, b: Vec2): Vec2 {
  return [a[0] - b[0], a[1] - b[1]];
}

export function add(a: Vec2, b: Vec2): Vec2 {
  return [a[0] + b[0], a[1] + b[1]];
}

export function scale(a: Vec2, s: number): Vec2 {
  return [a[0] * s, a[1] * s];
}

export function norm(a: Vec2): number {
  return Math.hypot(a[0], a[1]);
}

export function normalize(a: Vec2): Vec2 {
  const len = norm(a);
  return len > 1e-12 ? [a[0] / len, a[1] / len] : [1, 0];
}

export function perp(a: Vec2): Vec2 {
  return [-a[1], a[0]];
}

export function mid(a: Vec2, b: Vec2): Vec2 {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

export function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/** Synthesized read-model views of the implicit datums (origin + axes,
 * reserved negative ids). They have no statement child, so `model.entities`
 * never holds them; geometry is fixed by definition — the axes span the
 * visual extent so midpoints land on the origin and angle-glyph ray checks
 * see them as covering. `obj` is absent: datums have no source statement. */
const AXIS_VIEW_EXTENT = 1000;
const DATUM_VIEWS: Record<number, SolvedEntityView> = {
  [-1]: { entityId: -1, kind: 'point', point: [0, 0] },
  [-2]: { entityId: -2, kind: 'line', start: [-AXIS_VIEW_EXTENT, 0], end: [AXIS_VIEW_EXTENT, 0] },
  [-3]: { entityId: -3, kind: 'line', start: [0, -AXIS_VIEW_EXTENT], end: [0, AXIS_VIEW_EXTENT] },
};

export function entityFor(model: SolvedSketchModel, ref: SolverRef): SolvedEntityView | undefined {
  const own = model.entities.get(ref.entity);
  if (own) {
    return own;
  }
  if (ref.entity < 0 && model.hasDatums) {
    return DATUM_VIEWS[ref.entity];
  }
  return undefined;
}

/** The named point of a ref, when it has one (or the ref names a point
 * entity, which doubles as its own point). */
export function refPoint(model: SolvedSketchModel, ref: SolverRef): Vec2 | null {
  const e = entityFor(model, ref);
  if (!e) {
    return null;
  }
  if (!ref.point) {
    return e.kind === 'point' ? e.point ?? null : null;
  }
  switch (ref.point) {
    case 'start':
      return e.start ?? null;
    case 'end':
      return e.end ?? null;
    case 'center':
      return e.center ?? null;
  }
  return null;
}

export function lineMid(e: SolvedEntityView): Vec2 | null {
  if (!e.start || !e.end) {
    return null;
  }
  return mid(e.start, e.end);
}

export function lineDir(e: SolvedEntityView): Vec2 | null {
  if (!e.start || !e.end) {
    return null;
  }
  return normalize(sub(e.end, e.start));
}

/** Extension from the segment's nearest endpoint to `p`, when `p` lies
 * beyond the segment along its infinite line — the dashed helper leader an
 * angle dimension draws to a virtual intersection the segments don't
 * reach. Null when the segment already contains `p`'s projection. */
export function segmentExtensionTo(e: SolvedEntityView, p: Vec2): [Vec2, Vec2] | null {
  if (!e.start || !e.end) {
    return null;
  }
  const d = sub(e.end, e.start);
  const len2 = d[0] * d[0] + d[1] * d[1];
  if (len2 < 1e-18) {
    return null;
  }
  const t = ((p[0] - e.start[0]) * d[0] + (p[1] - e.start[1]) * d[1]) / len2;
  if (t >= 0 && t <= 1) {
    return null;
  }
  return [t < 0 ? e.start : e.end, p];
}

/** Does the segment extend from `at` along direction `r` (unit)? True when
 * an endpoint lies on the +r side — the sector-boundary ray is then covered
 * by visible geometry near `at`; false means an angle arc's end would float
 * in empty space there and needs a dashed tail to touch. */
export function segmentCoversRay(e: SolvedEntityView, at: Vec2, r: Vec2): boolean {
  if (!e.start || !e.end) {
    return false;
  }
  const ds = (e.start[0] - at[0]) * r[0] + (e.start[1] - at[1]) * r[1];
  const de = (e.end[0] - at[0]) * r[0] + (e.end[1] - at[1]) * r[1];
  return Math.max(ds, de) > 1e-9;
}

/** A line's direction oriented by a ref's point role: a bare ref (or its
 * 'end' point) is start→end, a 'start' point ref reverses — the angle
 * constraint's sector encoding (each ref orients its own line). */
export function orientedLineDir(e: SolvedEntityView, ref: SolverRef): Vec2 | null {
  const d = lineDir(e);
  if (!d) {
    return null;
  }
  return ref.point === 'start' ? [-d[0], -d[1]] : d;
}

/** Point on an arc halfway between its endpoints, on the drawn side. */
export function arcMidPoint(e: SolvedEntityView): Vec2 | null {
  if (!e.center || !e.start || !e.end || e.radius === undefined) {
    return null;
  }
  const a0 = Math.atan2(e.start[1] - e.center[1], e.start[0] - e.center[0]);
  const a1 = Math.atan2(e.end[1] - e.center[1], e.end[0] - e.center[0]);
  let sweep = a1 - a0;
  // cw arcs sweep negative; ccw positive — mirror the kernel's convention.
  if (e.cw) {
    if (sweep > 0) {
      sweep -= 2 * Math.PI;
    }
  } else if (sweep < 0) {
    sweep += 2 * Math.PI;
  }
  const a = a0 + sweep / 2;
  return [e.center[0] + Math.cos(a) * e.radius, e.center[1] + Math.sin(a) * e.radius];
}

/** A representative point on the entity for badge placement. */
export function entityAnchor(e: SolvedEntityView): Vec2 | null {
  switch (e.kind) {
    case 'point':
      return e.point ?? null;
    case 'line':
      return lineMid(e);
    case 'arc':
      return arcMidPoint(e) ?? e.center ?? null;
    case 'circle': {
      if (!e.center || e.radius === undefined) {
        return e.center ?? null;
      }
      const d = Math.SQRT1_2 * e.radius;
      return [e.center[0] + d, e.center[1] + d];
    }
  }
}

/** Anchor for a ref: its point when named, the entity's anchor otherwise. */
export function refAnchor(model: SolvedSketchModel, ref: SolverRef): Vec2 | null {
  return refPoint(model, ref) ?? (entityFor(model, ref) ? entityAnchor(entityFor(model, ref)!) : null);
}

/** Offset direction for a badge at `at` on the entity: perpendicular to a
 * line, radial on a circle/arc, up for points. `away` (the sketch centroid,
 * when known) breaks the perpendicular's sign ambiguity by pushing the badge
 * OUT of the profile — annotations belong outside the shape they describe.
 * Radial directions already point outward and are left alone. */
export function offsetDirAt(
  e: SolvedEntityView | undefined,
  at: Vec2,
  away: Vec2 | null = null,
): Vec2 {
  if (!e) {
    return [0, 1];
  }
  if (e.kind === 'line') {
    const d = lineDir(e);
    if (!d) {
      return [0, 1];
    }
    const n = perp(d);
    if (!away) {
      return n;
    }
    const outward = sub(at, away);
    return n[0] * outward[0] + n[1] * outward[1] < 0 ? [-n[0], -n[1]] : n;
  }
  if ((e.kind === 'circle' || e.kind === 'arc') && e.center) {
    const radial = sub(at, e.center);
    return norm(radial) > 1e-9 ? normalize(radial) : [0, 1];
  }
  return [0, 1];
}

/** Tangential direction at `at` — the axis a badge row runs along so the
 * group stays glued to its edge instead of marching away from it. */
export function alongDirAt(e: SolvedEntityView | undefined, at: Vec2): Vec2 {
  if (!e) {
    return [1, 0];
  }
  if (e.kind === 'line') {
    return lineDir(e) ?? [1, 0];
  }
  if ((e.kind === 'circle' || e.kind === 'arc') && e.center) {
    const radial = sub(at, e.center);
    return norm(radial) > 1e-9 ? perp(normalize(radial)) : [1, 0];
  }
  return [1, 0];
}

/**
 * Characteristic length of the entity in sketch units — how much room a
 * badge row riding it may claim. A line gives its full length; a circle or
 * arc gives its radius (about 57° of rim, comfortably inside the curve's
 * near-straight stretch). 0 means "no host edge", and the consumer applies
 * a flat allowance instead.
 */
export function entitySpan(e: SolvedEntityView | undefined): number {
  if (!e) {
    return 0;
  }
  if (e.kind === 'line') {
    return e.start && e.end ? dist(e.start, e.end) : 0;
  }
  if (e.kind === 'circle' || e.kind === 'arc') {
    return e.radius ?? 0;
  }
  return 0;
}

/** Centroid of every entity anchor — the "inside" reference `offsetDirAt`
 * pushes away from. Null when the sketch has nothing anchorable. */
export function sketchCentroid(model: SolvedSketchModel): Vec2 | null {
  let x = 0;
  let y = 0;
  let count = 0;
  for (const e of model.entities.values()) {
    const at = e.center ?? entityAnchor(e);
    if (at) {
      x += at[0];
      y += at[1];
      count += 1;
    }
  }
  return count > 0 ? [x / count, y / count] : null;
}

/** Foot of the perpendicular from `p` onto the infinite line of `e`. */
export function footOnLine(e: SolvedEntityView, p: Vec2): Vec2 | null {
  if (!e.start || !e.end) {
    return null;
  }
  const d = lineDir(e);
  if (!d) {
    return null;
  }
  const t = (p[0] - e.start[0]) * d[0] + (p[1] - e.start[1]) * d[1];
  return add(e.start, scale(d, t));
}

/** Nearest point on the circle/arc's circumference to `p`. */
export function pointOnCircumference(e: SolvedEntityView, p: Vec2): Vec2 | null {
  if (!e.center || e.radius === undefined) {
    return null;
  }
  const radial = sub(p, e.center);
  if (norm(radial) < 1e-9) {
    return add(e.center, [e.radius, 0]);
  }
  return add(e.center, scale(normalize(radial), e.radius));
}

/** Where two entities touch under a tangent constraint: the perpendicular
 * foot for line–circle, the point along the center line for circle–circle.
 * Falls back to the midpoint of anchors when a form is missing data. */
export function tangencyPoint(a: SolvedEntityView, b: SolvedEntityView): Vec2 | null {
  const line = a.kind === 'line' ? a : b.kind === 'line' ? b : null;
  const round = a.kind === 'line' ? b : a;
  if (line && round.center) {
    return footOnLine(line, round.center);
  }
  if (a.center && b.center && a.radius !== undefined) {
    return pointOnCircumference(a, b.center);
  }
  const anchorA = entityAnchor(a);
  const anchorB = entityAnchor(b);
  return anchorA && anchorB ? mid(anchorA, anchorB) : anchorA ?? anchorB;
}

/** Intersection of the infinite lines of two line entities. */
export function lineIntersection(a: SolvedEntityView, b: SolvedEntityView): Vec2 | null {
  if (!a.start || !b.start) {
    return null;
  }
  const da = lineDir(a);
  const db = lineDir(b);
  if (!da || !db) {
    return null;
  }
  const cross = da[0] * db[1] - da[1] * db[0];
  if (Math.abs(cross) < 1e-9) {
    return null;
  }
  const dx = b.start[0] - a.start[0];
  const dy = b.start[1] - a.start[1];
  const t = (dx * db[1] - dy * db[0]) / cross;
  return add(a.start, scale(da, t));
}

/**
 * Does the segment a→b lie ALONG some line entity of the sketch — collinear
 * with it and overlapping it for a real length? This is what makes a
 * distance leader between two points of a straight edge invisible: it draws
 * exactly on top of the edge. Tolerances are relative, so the test is
 * zoom- and scale-free.
 */
export function segmentRidesEntityLine(
  model: SolvedSketchModel,
  a: Vec2,
  b: Vec2,
): boolean {
  const span = dist(a, b);
  if (span < 1e-12) {
    return false;
  }
  for (const e of model.entities.values()) {
    if (e.kind !== 'line' || !e.start || !e.end) {
      continue;
    }
    const len = dist(e.start, e.end);
    if (len < 1e-12) {
      continue;
    }
    const ed: Vec2 = [(e.end[0] - e.start[0]) / len, (e.end[1] - e.start[1]) / len];
    const tol = Math.max(span, len) * 1e-3;
    const off = (p: Vec2): number =>
      Math.abs((p[0] - e.start![0]) * ed[1] - (p[1] - e.start![1]) * ed[0]);
    if (off(a) > tol || off(b) > tol) {
      continue;
    }
    const t = (p: Vec2): number =>
      (p[0] - e.start![0]) * ed[0] + (p[1] - e.start![1]) * ed[1];
    const t0 = Math.min(t(a), t(b));
    const t1 = Math.max(t(a), t(b));
    if (Math.min(t1, len) - Math.max(t0, 0) > 0.05 * span) {
      return true;
    }
  }
  return false;
}
