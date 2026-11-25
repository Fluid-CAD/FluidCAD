import type { Curve2D, Vec2 } from "./drawing.js";
import { Affine, type Affine2 } from "./affine.js";
import { Conic } from "./conic.js";

/**
 * One piece of a drawn outline, with the direction it is drawn in — what a
 * path is made of before it becomes drawing curves:
 *
 * - `line` from `a` to `b`;
 * - `bezier` through its control points, three (quadratic) or four (cubic);
 * - `conic`: the points `center + cos t · u + sin t · v` for `t` from `t0`
 *   up to `t1` — a circle or an ellipse, whole or in part, by a pair of
 *   conjugate semi-diameters. The form an affine map keeps: mapped, it is
 *   the same thing with `center`, `u` and `v` mapped.
 */
export type PathSegment =
  | { kind: 'line'; a: Vec2; b: Vec2 }
  | { kind: 'bezier'; points: Vec2[] }
  | { kind: 'conic'; center: Vec2; u: Vec2; v: Vec2; t0: number; t1: number };

type ConicSegment = Extract<PathSegment, { kind: 'conic' }>;

/** The segments drawn in one go, each starting where the one before it ends; `closed` when the last ends where the first starts. */
export type Subpath = { segments: PathSegment[]; closed: boolean };

const TWO_PI = 2 * Math.PI;

/**
 * How far, in radii, a curve may stray from a circle and still be that
 * circle: a thousandth. The cubic that programs draw a quarter circle with
 * strays 0.00027 radii from it, and a file's rounded numbers add to that.
 */
const CIRCLE_TOLERANCE = 1e-3;

/**
 * And how far in shares of its own depth — the distance its middle bows
 * from its chord. A radius says nothing about a shallow curve: any gentle
 * bow lies within a thousandth of some large circle's radius.
 */
const BOW_TOLERANCE = 5e-3;

/** No single cubic follows more of a circle than this closely enough to be read as its arc. */
const MAX_BEZIER_ARC = Math.PI;

/** A conic whose semi-diameters differ by less than this share of their length, and are this square to each other, is a circle. */
const ROUND_TOLERANCE = 1e-6;

/** Where a bezier is compared with the circle it may follow: this many equal steps, ends excluded. */
const ARC_CHECKS = 16;

/** Arcs that together come this close to a full turn (radians) and end where they began are the whole circle. */
const FULL_TURN_SLACK = 0.05;

/**
 * Geometry of path segments: taking them through a transform, seeing the
 * circles in them, and handing them over as drawing curves.
 *
 * A file format often cannot say "circle" where a drawing has one: a path
 * states a circle as two or more arcs, and a program that has no arc at all
 * writes four cubic béziers. Read literally that is a ring of pieces to
 * join, with no centre to dimension — so pieces that follow one circle are
 * put back together here, and a bezier that follows a circle is that arc.
 */
export class PathSegments {
  /** The segment under an affine map: exact for all three kinds. */
  static map(m: Affine2, segment: PathSegment): PathSegment {
    switch (segment.kind) {
      case 'line':
        return { kind: 'line', a: Affine.point(m, segment.a), b: Affine.point(m, segment.b) };
      case 'bezier':
        return { kind: 'bezier', points: segment.points.map((p) => Affine.point(m, p)) };
      case 'conic':
        return {
          kind: 'conic',
          center: Affine.point(m, segment.center),
          u: Affine.vector(m, segment.u),
          v: Affine.vector(m, segment.v),
          t0: segment.t0,
          t1: segment.t1,
        };
    }
  }

  static start(segment: PathSegment): Vec2 {
    switch (segment.kind) {
      case 'line':
        return segment.a;
      case 'bezier':
        return segment.points[0];
      case 'conic':
        return PathSegments.conicPoint(segment, segment.t0);
    }
  }

  static end(segment: PathSegment): Vec2 {
    switch (segment.kind) {
      case 'line':
        return segment.b;
      case 'bezier':
        return segment.points[segment.points.length - 1];
      case 'conic':
        return PathSegments.conicPoint(segment, segment.t1);
    }
  }

  static conicPoint(conic: ConicSegment, t: number): Vec2 {
    const cos = Math.cos(t);
    const sin = Math.sin(t);
    return {
      x: conic.center.x + cos * conic.u.x + sin * conic.v.x,
      y: conic.center.y + cos * conic.u.y + sin * conic.v.y,
    };
  }

  /** Whether every number of the segment is one: a transform that divides by nothing leaves some that are not. */
  static isFinite(segment: PathSegment): boolean {
    const ok = (p: Vec2) => Number.isFinite(p.x) && Number.isFinite(p.y);
    switch (segment.kind) {
      case 'line':
        return ok(segment.a) && ok(segment.b);
      case 'bezier':
        return segment.points.every(ok);
      case 'conic':
        return ok(segment.center) && ok(segment.u) && ok(segment.v) && Number.isFinite(segment.t0) && Number.isFinite(segment.t1);
    }
  }

  /** How far the segment reaches from where it starts; zero for one that goes nowhere. */
  static reach(segment: PathSegment): number {
    switch (segment.kind) {
      case 'line':
        return Math.hypot(segment.b.x - segment.a.x, segment.b.y - segment.a.y);
      case 'bezier': {
        let reach = 0;
        for (const p of segment.points) {
          reach = Math.max(reach, Math.hypot(p.x - segment.points[0].x, p.y - segment.points[0].y));
        }
        return reach;
      }
      case 'conic':
        return Math.max(Math.hypot(segment.u.x, segment.u.y), Math.hypot(segment.v.x, segment.v.y)) * Math.min(segment.t1 - segment.t0, 1);
    }
  }

  /**
   * The circular arc a cubic bezier follows, or null when it follows none.
   *
   * The circle is the one through the bezier's two ends and its middle
   * point — so the arc starts and ends exactly where the bezier does, and
   * what was joined to it stays joined. The bezier is that arc when all of
   * it stays on the circle, going one way round: within a thousandth of the
   * radius, and within a two-hundredth of how far the arc bows from its
   * chord — a shallow curve is near many circles, and only one that keeps
   * to its own is taken for an arc.
   */
  static arcOf(segment: PathSegment): ConicSegment | null {
    if (segment.kind !== 'bezier' || segment.points.length !== 4) {
      return null;
    }
    const [p0, p1, p2, p3] = segment.points;
    const at = (t: number): Vec2 => {
      const r = 1 - t;
      const [k0, k1, k2, k3] = [r * r * r, 3 * r * r * t, 3 * r * t * t, t * t * t];
      return {
        x: k0 * p0.x + k1 * p1.x + k2 * p2.x + k3 * p3.x,
        y: k0 * p0.y + k1 * p1.y + k2 * p2.y + k3 * p3.y,
      };
    };
    // The circle through the two ends and the middle, worked out from the first end.
    const middle = at(0.5);
    const b = { x: middle.x - p0.x, y: middle.y - p0.y };
    const c = { x: p3.x - p0.x, y: p3.y - p0.y };
    const chord = Math.hypot(c.x, c.y);
    const d = 2 * (b.x * c.y - b.y * c.x);
    if (!(chord > 0) || !(Math.abs(d) > 1e-12 * chord * chord)) {
      return null;
    }
    const bb = b.x * b.x + b.y * b.y;
    const cc = c.x * c.x + c.y * c.y;
    const center = { x: p0.x + (c.y * bb - b.y * cc) / d, y: p0.y + (b.x * cc - c.x * bb) / d };
    const u = { x: p0.x - center.x, y: p0.y - center.y };
    const radius = Math.hypot(u.x, u.y);
    if (!Number.isFinite(radius) || !(radius > 0)) {
      return null;
    }
    // How far the middle bows from the chord: the arc's own depth.
    const bow = Math.abs(b.x * c.y - b.y * c.x) / chord;
    const tolerance = Math.min(radius * CIRCLE_TOLERANCE, bow * BOW_TOLERANCE);

    // Along the bezier: on the circle, and turning one way.
    let turn = 0;
    let sense = 0;
    let previous = u;
    for (let i = 1; i <= ARC_CHECKS; i++) {
      const p = at(i / ARC_CHECKS);
      const q = { x: p.x - center.x, y: p.y - center.y };
      if (Math.abs(Math.hypot(q.x, q.y) - radius) > tolerance) {
        return null;
      }
      const step = Math.atan2(previous.x * q.y - previous.y * q.x, previous.x * q.x + previous.y * q.y);
      if (step === 0 || (sense !== 0 && Math.sign(step) !== sense)) {
        return null;
      }
      sense = Math.sign(step);
      turn += step;
      previous = q;
    }
    const sweep = Math.abs(turn);
    if (!(sweep > 0) || sweep > MAX_BEZIER_ARC) {
      return null;
    }
    return { kind: 'conic', center, u, v: { x: -u.y * sense, y: u.x * sense }, t0: 0, t1: sweep };
  }

  /**
   * The subpath with every run of arcs on one circle made one arc — the
   * whole circle when the run goes all the way round — and a run of
   * elliptical arcs that closes its ellipse made that ellipse. With `arcs`,
   * a cubic bezier that follows a circle is first read as that arc.
   * `recognized` counts those.
   */
  static joined(subpath: Subpath, options: { arcs: boolean }): { segments: PathSegment[]; recognized: number } {
    let recognized = 0;
    /** A run of conics on one carrier, in drawing order. */
    type Run = { parts: ConicSegment[]; round: boolean };
    const items: (PathSegment | Run)[] = [];
    const isRun = (item: PathSegment | Run | undefined): item is Run => item !== undefined && 'parts' in item;

    for (const source of subpath.segments) {
      let segment = source;
      if (options.arcs) {
        const arc = PathSegments.arcOf(source);
        if (arc) {
          segment = arc;
          recognized++;
        }
      }
      if (segment.kind !== 'conic') {
        items.push(segment);
        continue;
      }
      const last = items[items.length - 1];
      if (isRun(last) && PathSegments.continues(last.parts[last.parts.length - 1], segment)) {
        last.parts.push(segment);
      } else {
        items.push({ parts: [segment], round: PathSegments.isRound(segment) });
      }
    }
    // A closed outline may start in the middle of a run: its last run then continues into its first.
    const first = items[0];
    const last = items[items.length - 1];
    if (subpath.closed && items.length > 1 && isRun(first) && isRun(last)
      && PathSegments.continues(last.parts[last.parts.length - 1], first.parts[0])) {
      first.parts.unshift(...last.parts);
      items.pop();
    }

    const segments: PathSegment[] = [];
    for (const item of items) {
      if (!isRun(item)) {
        segments.push(item);
      } else if (item.parts.length === 1) {
        segments.push(item.parts[0]);
      } else {
        segments.push(...(item.round ? PathSegments.circleOf(item.parts) : PathSegments.ellipseOf(item.parts)));
      }
    }
    return { segments, recognized };
  }

  /**
   * The drawing curve of a segment; null when nothing is left of it.
   * `tolerance` is a length: what a conic's two axes may differ by and
   * still be a circle's.
   */
  static curve(segment: PathSegment, tolerance: number): Curve2D | null {
    switch (segment.kind) {
      case 'line':
        return { kind: 'line', a: segment.a, b: segment.b };
      case 'bezier': {
        const degree = segment.points.length - 1;
        const knots: number[] = [];
        for (let i = 0; i <= degree; i++) {
          knots.push(0);
        }
        for (let i = 0; i <= degree; i++) {
          knots.push(1);
        }
        return { kind: 'bspline', degree, knots, poles: segment.points };
      }
      case 'conic':
        return Conic.fromConjugateDiameters(segment.center, segment.u, segment.v, segment.t0, segment.t1, tolerance);
    }
  }

  // ─── Circles ────────────────────────────────────────────────────────────

  private static isRound(conic: ConicSegment): boolean {
    const a = Math.hypot(conic.u.x, conic.u.y);
    const b = Math.hypot(conic.v.x, conic.v.y);
    return Math.abs(a - b) <= ROUND_TOLERANCE * a && Math.abs(conic.u.x * conic.v.x + conic.u.y * conic.v.y) <= ROUND_TOLERANCE * a * b;
  }

  /** +1 when the conic runs counter-clockwise in its coordinates, −1 when clockwise. */
  private static sense(conic: ConicSegment): number {
    return Math.sign(conic.u.x * conic.v.y - conic.u.y * conic.v.x);
  }

  /**
   * Whether `next` carries on where `conic` stops, on the same curve and
   * the same way round. Two circles are one when their centres and radii
   * agree within a thousandth of the radius; two elliptical arcs when the
   * second lies on the first one's ellipse, drawn on.
   */
  private static continues(conic: ConicSegment, next: ConicSegment): boolean {
    const size = Math.max(Math.hypot(conic.u.x, conic.u.y), Math.hypot(conic.v.x, conic.v.y));
    const tolerance = size * CIRCLE_TOLERANCE;
    const far = (p: Vec2, q: Vec2) => Math.hypot(p.x - q.x, p.y - q.y);
    if (PathSegments.sense(conic) !== PathSegments.sense(next) || PathSegments.sense(conic) === 0) {
      return false;
    }
    if (far(PathSegments.end(conic), PathSegments.start(next)) > tolerance || far(conic.center, next.center) > tolerance) {
      return false;
    }
    if (PathSegments.isRound(conic) && PathSegments.isRound(next)) {
      return Math.abs(Math.hypot(next.u.x, next.u.y) - Math.hypot(conic.u.x, conic.u.y)) <= tolerance;
    }
    // The same ellipse, drawn on: the first one's points past its end are the second one's.
    const sweep = next.t1 - next.t0;
    return far(PathSegments.conicPoint(conic, conic.t1 + sweep / 2), PathSegments.conicPoint(next, next.t0 + sweep / 2)) <= tolerance
      && far(PathSegments.conicPoint(conic, conic.t1 + sweep), PathSegments.end(next)) <= tolerance;
  }

  /**
   * Arcs of one circle, end to end, as one: the circle when they go all the
   * way round, else the arc from the first one's start to the last one's
   * end. Its centre is the pieces' own, averaged by how much of the circle
   * each draws, then moved onto the bisector of the two ends so both stay
   * exactly where they were.
   */
  private static circleOf(parts: ConicSegment[]): PathSegment[] {
    let sweep = 0;
    const center = { x: 0, y: 0 };
    let radius = 0;
    for (const part of parts) {
      const share = part.t1 - part.t0;
      sweep += share;
      center.x += part.center.x * share;
      center.y += part.center.y * share;
      radius += Math.hypot(part.u.x, part.u.y) * share;
    }
    center.x /= sweep;
    center.y /= sweep;
    radius /= sweep;
    const sense = PathSegments.sense(parts[0]);
    const start = PathSegments.start(parts[0]);
    const end = PathSegments.end(parts[parts.length - 1]);
    const gap = Math.hypot(end.x - start.x, end.y - start.y);

    if (sweep > TWO_PI - FULL_TURN_SLACK && (gap <= radius * CIRCLE_TOLERANCE * 2 || sweep >= TWO_PI)) {
      return [{ kind: 'conic', center, u: { x: radius, y: 0 }, v: { x: 0, y: radius * sense }, t0: 0, t1: TWO_PI }];
    }
    if (!(gap > radius * 1e-6)) {
      // Ends that meet short of a full turn: nothing to rebuild the arc on.
      return parts;
    }
    const middle = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
    const across = { x: -(end.y - start.y) / gap, y: (end.x - start.x) / gap };
    const offset = (center.x - middle.x) * across.x + (center.y - middle.y) * across.y;
    const fitted = { x: middle.x + offset * across.x, y: middle.y + offset * across.y };
    const u = { x: start.x - fitted.x, y: start.y - fitted.y };
    const w = { x: end.x - fitted.x, y: end.y - fitted.y };
    let angle = Math.atan2((u.x * w.y - u.y * w.x) * sense, u.x * w.x + u.y * w.y);
    if (angle <= 0) {
      angle += TWO_PI;
    }
    // The angle between the ends is known up to a turn: the pieces say which.
    if (Math.abs(angle - sweep) > Math.PI) {
      return parts;
    }
    return [{ kind: 'conic', center: fitted, u, v: { x: -u.y * sense, y: u.x * sense }, t0: 0, t1: angle }];
  }

  /**
   * Arcs of one ellipse, end to end: the whole ellipse when they close it,
   * else the arcs as they were — a part of an ellipse is as good in two
   * pieces as in one, and each piece ends exactly where its file put it.
   */
  private static ellipseOf(parts: ConicSegment[]): PathSegment[] {
    let sweep = 0;
    for (const part of parts) {
      sweep += part.t1 - part.t0;
    }
    const first = parts[0];
    const start = PathSegments.start(first);
    const end = PathSegments.end(parts[parts.length - 1]);
    const size = Math.max(Math.hypot(first.u.x, first.u.y), Math.hypot(first.v.x, first.v.y));
    const closes = Math.hypot(end.x - start.x, end.y - start.y) <= size * CIRCLE_TOLERANCE * 2;
    if (sweep > TWO_PI - FULL_TURN_SLACK && (closes || sweep >= TWO_PI)) {
      return [{ kind: 'conic', center: first.center, u: first.u, v: first.v, t0: 0, t1: TWO_PI }];
    }
    return parts;
  }
}
