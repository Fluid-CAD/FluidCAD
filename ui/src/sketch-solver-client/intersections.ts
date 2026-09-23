// Sketch-local crossings between solved entities — the cut points the
// Trim tool bounds a segment with. Lines, arcs and circles meet
// analytically; an ellipse or a bezier curve is walked as a fine polyline,
// so a crossing with one is exact to that polyline's chord error. Contact
// is judged at the source's own resolution: the literals hold two
// decimals, so an end the tools wrote onto another edge can miss it by
// half a hundredth and must still count as touching it.

import type { SolvedBezierView, SolvedEntityView, SolvedSketchModel } from './model';
import { bezierControlPoints } from './model';
import { angleWithinSweep, arcSweep, tessellateBezier, tessellateSolvedEntity } from './tessellate';
import { add, dist, norm, scale, sub, type Vec2 } from './resolve';

/**
 * How far (sketch units) a curve may stop short of, or reach past, another
 * and still touch it: the two-decimal resolution of the source literals.
 * Two crossings this close are one; a crossing this close to the target's
 * own end is that end.
 */
export const CONTACT_TOL = 0.01;
/** Chords a curve without an analytic form is walked as. */
const CURVE_SEGMENTS = 256;

/** The intersectable form of an entity. */
export type Curve =
  | { kind: 'segment'; a: Vec2; b: Vec2 }
  | { kind: 'circle'; center: Vec2; radius: number; arc?: { a0: number; sweep: number } }
  | { kind: 'polyline'; points: Vec2[] };

type Segment = Extract<Curve, { kind: 'segment' }>;
type Circle = Extract<Curve, { kind: 'circle' }>;

/** Where another curve crosses or touches the target, and what crosses there. */
export type Crossing = {
  point: Vec2;
  /** The entity crossing there; null for a bezier curve. */
  entityId: number | null;
  /** Set when the crossing sits at that entity's own start or end — a T-junction. */
  role?: 'start' | 'end';
};

/** The curve an entity draws; null for a point or an incomplete view. */
export function curveOf(view: SolvedEntityView): Curve | null {
  switch (view.kind) {
    case 'line':
      return view.start && view.end ? { kind: 'segment', a: view.start, b: view.end } : null;
    case 'circle':
      return view.center && view.radius !== undefined
        ? { kind: 'circle', center: view.center, radius: view.radius }
        : null;
    case 'arc': {
      const arc = arcSweep(view);
      return arc && view.center && view.radius !== undefined
        ? { kind: 'circle', center: view.center, radius: view.radius, arc }
        : null;
    }
    case 'ellipse': {
      const points = tessellateSolvedEntity(view, CURVE_SEGMENTS);
      return points ? { kind: 'polyline', points } : null;
    }
    default:
      return null;
  }
}

/** The curve a bezier statement draws, through its current control points. */
export function bezierCurve(model: SolvedSketchModel, bezier: SolvedBezierView): Curve | null {
  const points = tessellateBezier(bezierControlPoints(model, bezier), CURVE_SEGMENTS);
  return points ? { kind: 'polyline', points } : null;
}

/** Every point where two curves meet, touching ends included; not deduplicated. */
export function curveIntersections(a: Curve, b: Curve): Vec2[] {
  if (a.kind === 'polyline') {
    const found: Vec2[] = [];
    for (let i = 1; i < a.points.length; i++) {
      found.push(...curveIntersections({ kind: 'segment', a: a.points[i - 1], b: a.points[i] }, b));
    }
    return found;
  }
  if (b.kind === 'polyline') {
    return curveIntersections(b, a);
  }
  if (a.kind === 'segment') {
    return b.kind === 'segment' ? segmentSegment(a, b) : segmentCircle(a, b);
  }
  return b.kind === 'segment' ? segmentCircle(b, a) : circleCircle(a, b);
}

/**
 * Where the other entities and bezier curves of the sketch cross or touch
 * `target`, strictly inside it: a crossing at the target's own end is a
 * corner, not a place to cut. Deduplicated; a crossing that sits at the
 * crossing entity's own end records that end.
 */
export function entityIntersections(target: SolvedEntityView, model: SolvedSketchModel): Crossing[] {
  const curve = curveOf(target);
  if (!curve) {
    return [];
  }
  const found: Crossing[] = [];
  for (const other of model.entities.values()) {
    if (other.entityId === target.entityId) {
      continue;
    }
    const c = curveOf(other);
    if (!c) {
      continue;
    }
    for (const point of curveIntersections(curve, c)) {
      found.push({ point, entityId: other.entityId, ...endRoleAt(other, point) });
    }
  }
  for (const bezier of model.beziers.values()) {
    const c = bezierCurve(model, bezier);
    if (!c) {
      continue;
    }
    for (const point of curveIntersections(curve, c)) {
      found.push({ point, entityId: null });
    }
  }
  const ends = [target.start, target.end].filter((p): p is Vec2 => p !== undefined);
  const unique: Crossing[] = [];
  for (const crossing of found) {
    if (ends.some(e => dist(e, crossing.point) <= CONTACT_TOL)) {
      continue;
    }
    const twin = unique.find(u => dist(u.point, crossing.point) <= CONTACT_TOL);
    if (!twin) {
      unique.push(crossing);
    } else if (twin.role === undefined && crossing.role !== undefined) {
      // The same place seen as an end of something: the end names it better.
      twin.entityId = crossing.entityId;
      twin.role = crossing.role;
    }
  }
  return unique;
}

/** The end of `view` a point sits on, when it does. */
function endRoleAt(view: SolvedEntityView, point: Vec2): { role?: 'start' | 'end' } {
  if (view.start && dist(point, view.start) <= CONTACT_TOL) {
    return { role: 'start' };
  }
  if (view.end && dist(point, view.end) <= CONTACT_TOL) {
    return { role: 'end' };
  }
  return {};
}

function cross(a: Vec2, b: Vec2): number {
  return a[0] * b[1] - a[1] * b[0];
}

function dot(a: Vec2, b: Vec2): number {
  return a[0] * b[0] + a[1] * b[1];
}

/** Whether parameter `t` (0 at one end, 1 at the other) lies on a segment of `length`, within CONTACT_TOL of it. */
function onSegment(t: number, length: number): boolean {
  const slack = CONTACT_TOL / length;
  return t >= -slack && t <= 1 + slack;
}

/** The parameter of `p` along `s` (0 at `a`, 1 at `b`), for a point on its line. */
function paramOn(s: Segment, p: Vec2): number {
  const d = sub(s.b, s.a);
  return dot(sub(p, s.a), d) / dot(d, d);
}

function segmentSegment(s: Segment, t: Segment): Vec2[] {
  const r = sub(s.b, s.a);
  const q = sub(t.b, t.a);
  const rLength = norm(r);
  const qLength = norm(q);
  if (rLength * qLength < 1e-24) {
    return [];
  }
  const d = sub(t.a, s.a);
  const denom = cross(r, q);
  if (Math.abs(denom) <= 1e-12 * rLength * qLength) {
    // Parallel. Collinear segments meet wherever one's end lies on the other.
    if (Math.abs(cross(d, r)) / rLength > CONTACT_TOL) {
      return [];
    }
    return [
      ...[t.a, t.b].filter(p => onSegment(paramOn(s, p), rLength)),
      ...[s.a, s.b].filter(p => onSegment(paramOn(t, p), qLength)),
    ];
  }
  const u = cross(d, q) / denom;
  const v = cross(d, r) / denom;
  return onSegment(u, rLength) && onSegment(v, qLength) ? [add(s.a, scale(r, u))] : [];
}

function onArc(c: Circle, p: Vec2): boolean {
  return !c.arc || angleWithinSweep(
    c.arc.a0, c.arc.sweep, Math.atan2(p[1] - c.center[1], p[0] - c.center[0]), CONTACT_TOL / c.radius,
  );
}

function segmentCircle(s: Segment, c: Circle): Vec2[] {
  const d = sub(s.b, s.a);
  const length = norm(d);
  if (length < 1e-12) {
    return [];
  }
  const f = sub(s.a, c.center);
  // A line that misses the circle by no more than the contact tolerance
  // touches it where it comes nearest — a tangency the source rounded off.
  if (Math.abs(cross(d, f)) / length > c.radius + CONTACT_TOL) {
    return [];
  }
  const qa = dot(d, d);
  const qb = 2 * dot(f, d);
  const qc = dot(f, f) - c.radius * c.radius;
  const disc = qb * qb - 4 * qa * qc;
  const root = disc > 0 ? Math.sqrt(disc) : 0;
  const ts = root === 0 ? [-qb / (2 * qa)] : [(-qb - root) / (2 * qa), (-qb + root) / (2 * qa)];
  return ts.filter(t => onSegment(t, length)).map(t => add(s.a, scale(d, t))).filter(p => onArc(c, p));
}

function circleCircle(p: Circle, q: Circle): Vec2[] {
  const between = sub(q.center, p.center);
  const d = norm(between);
  if (d < 1e-9 * (p.radius + q.radius)) {
    return [];
  }
  if (d > p.radius + q.radius + CONTACT_TOL || d < Math.abs(p.radius - q.radius) - CONTACT_TOL) {
    return [];
  }
  const a = (p.radius * p.radius - q.radius * q.radius + d * d) / (2 * d);
  const m = add(p.center, scale(between, a / d));
  const h2 = p.radius * p.radius - a * a;
  let points: Vec2[];
  if (h2 <= 0) {
    // Touching within the contact tolerance: one point on the center line.
    points = [m];
  } else {
    const h = Math.sqrt(h2);
    const n: Vec2 = [-between[1] / d, between[0] / d];
    points = [add(m, scale(n, h)), sub(m, scale(n, h))];
  }
  return points.filter(x => onArc(p, x) && onArc(q, x));
}
