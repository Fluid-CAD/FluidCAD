import type { Curve2D, Vec2 } from "./drawing.js";

type BSpline = Extract<Curve2D, { kind: 'bspline' }>;

/** Where a cubic piece is compared with the curve it stands for: this many equal steps, ends excluded. */
const HERMITE_CHECKS = 8;

/** A piece is halved at most this many times; 2^-12 of a knot span is far below any tolerance asked for. */
const HERMITE_MAX_DEPTH = 12;

/** Tangents this close (relative to their length) on both sides of a breakpoint are one tangent. */
const TANGENT_JOIN_RELATIVE = 1e-9;

/**
 * NURBS utilities for the drawing model's `bspline` curves: a flat clamped
 * knot vector, poles, optional weights. Pure TypeScript — what the cleanup
 * pass, the writers and the tests evaluate curves with, without the kernel.
 */
export class BSplineCurve2D {
  /**
   * The flat knot vector for the kernel's (distinct knots, multiplicities)
   * pair — the form DXF writes and de Boor evaluates on.
   */
  static flattenKnots(knots: readonly number[], multiplicities: readonly number[]): number[] {
    if (knots.length !== multiplicities.length) {
      throw new Error(`B-spline has ${knots.length} knots but ${multiplicities.length} multiplicities`);
    }
    const flat: number[] = [];
    knots.forEach((knot, i) => {
      for (let m = 0; m < multiplicities[i]; m++) {
        flat.push(knot);
      }
    });
    return flat;
  }

  /** Why the curve's data cannot describe a clamped NURBS; null when it can. */
  static invalidReason(curve: BSpline): string | null {
    const { degree, knots, poles, weights } = curve;
    if (!Number.isInteger(degree) || degree < 1) {
      return `degree ${degree} is not a positive integer`;
    }
    if (poles.length < degree + 1) {
      return `${poles.length} poles are too few for degree ${degree}`;
    }
    if (knots.length !== poles.length + degree + 1) {
      return `${knots.length} knots for ${poles.length} poles of degree ${degree} (need ${poles.length + degree + 1})`;
    }
    for (let i = 1; i < knots.length; i++) {
      if (knots[i] < knots[i - 1]) {
        return 'knots decrease';
      }
    }
    if (weights && weights.length !== poles.length) {
      return `${weights.length} weights for ${poles.length} poles`;
    }
    if (weights && weights.some((w) => !(w > 0))) {
      return 'a weight is not positive';
    }
    return null;
  }

  /** The parameter range the curve is defined on: `[knots[degree], knots[poles.length]]`. */
  static domain(curve: BSpline): [number, number] {
    return [curve.knots[curve.degree], curve.knots[curve.poles.length]];
  }

  /** The point at `t` (clamped into the domain), by de Boor's algorithm in homogeneous coordinates. */
  static evaluate(curve: BSpline, t: number): Vec2 {
    const { degree, knots, poles, weights } = curve;
    const [t0, t1] = BSplineCurve2D.domain(curve);
    const u = Math.min(Math.max(t, t0), t1);

    // The span [knots[k], knots[k + 1]) holding u; the last non-empty one at the domain's end.
    let k = poles.length - 1;
    if (u < t1) {
      let lo = degree;
      let hi = poles.length;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (knots[mid] <= u) {
          lo = mid;
        } else {
          hi = mid;
        }
      }
      k = lo;
    } else {
      while (k > degree && knots[k] >= t1) {
        k--;
      }
    }

    const x: number[] = [];
    const y: number[] = [];
    const w: number[] = [];
    for (let j = 0; j <= degree; j++) {
      const index = k - degree + j;
      const weight = weights ? weights[index] : 1;
      x.push(poles[index].x * weight);
      y.push(poles[index].y * weight);
      w.push(weight);
    }
    for (let r = 1; r <= degree; r++) {
      for (let j = degree; j >= r; j--) {
        const index = k - degree + j;
        const span = knots[index + degree - r + 1] - knots[index];
        const alpha = span === 0 ? 0 : (u - knots[index]) / span;
        x[j] = (1 - alpha) * x[j - 1] + alpha * x[j];
        y[j] = (1 - alpha) * y[j - 1] + alpha * y[j];
        w[j] = (1 - alpha) * w[j - 1] + alpha * w[j];
      }
    }
    return { x: x[degree] / w[degree], y: y[degree] / w[degree] };
  }

  /** `count + 1` points evenly spaced in the parameter, both ends included. */
  static sample(curve: BSpline, count: number): Vec2[] {
    const [t0, t1] = BSplineCurve2D.domain(curve);
    const points: Vec2[] = [];
    for (let i = 0; i <= count; i++) {
      points.push(BSplineCurve2D.evaluate(curve, t0 + ((t1 - t0) * i) / count));
    }
    return points;
  }

  /**
   * The segment every pole lies on, when they all sit within `tolerance` of
   * one line — a planar curve seen edge-on. The curve stays inside its
   * poles' hull, so its drawing is the stretch of that line it covers, found
   * by sampling and closing in on the turning points (the curve may double
   * back and stop short of its end poles).
   * `'point'` when the poles collapse to one spot; null when they span a
   * real curve.
   */
  static collinearExtent(curve: BSpline, tolerance: number): { a: Vec2; b: Vec2 } | 'point' | null {
    const { poles } = curve;
    // The two poles farthest apart along the wider axis give the direction.
    let far = 0;
    let anchor = poles[0];
    let tip = poles[0];
    for (const p of poles) {
      for (const q of poles) {
        const d = Math.hypot(p.x - q.x, p.y - q.y);
        if (d > far) {
          far = d;
          anchor = p;
          tip = q;
        }
      }
    }
    if (far <= tolerance) {
      return 'point';
    }
    const dx = (tip.x - anchor.x) / far;
    const dy = (tip.y - anchor.y) / far;
    for (const p of poles) {
      const off = Math.abs((p.x - anchor.x) * dy - (p.y - anchor.y) * dx);
      if (off > tolerance) {
        return null;
      }
    }
    const along = (t: number) => {
      const p = BSplineCurve2D.evaluate(curve, t);
      return (p.x - anchor.x) * dx + (p.y - anchor.y) * dy;
    };
    const [t0, t1] = BSplineCurve2D.domain(curve);
    const count = Math.max(64, poles.length * 16);
    const step = (t1 - t0) / count;
    let minAt = t0;
    let maxAt = t0;
    for (let i = 1; i <= count; i++) {
      const t = t0 + step * i;
      if (along(t) < along(minAt)) {
        minAt = t;
      }
      if (along(t) > along(maxAt)) {
        maxAt = t;
      }
    }
    // A turning point inside the curve falls between two samples: close in on it.
    const refine = (around: number, sign: 1 | -1) => {
      let lo = Math.max(t0, around - step);
      let hi = Math.min(t1, around + step);
      for (let i = 0; i < 60; i++) {
        const a = lo + (hi - lo) / 3;
        const b = hi - (hi - lo) / 3;
        if (sign * along(a) < sign * along(b)) {
          lo = a;
        } else {
          hi = b;
        }
      }
      return along((lo + hi) / 2);
    };
    const min = Math.min(along(minAt), refine(minAt, -1));
    const max = Math.max(along(maxAt), refine(maxAt, 1));
    if (max - min <= tolerance) {
      return 'point';
    }
    return {
      a: { x: anchor.x + dx * min, y: anchor.y + dy * min },
      b: { x: anchor.x + dx * max, y: anchor.y + dy * max },
    };
  }

  /**
   * The curve as a non-rational cubic B-spline no farther than `tolerance`
   * from it; the curve itself when it already is one (degree ≤ 3, no
   * weights).
   *
   * Why this exists: a DXF `SPLINE` may be of any degree, and the kernel's
   * intersection curves are of degree 5 or 6 — but common readers (LibreCAD
   * among them) draw nothing for a spline above degree 3, and SVG has
   * nothing above a cubic at all. The cubic is the form everything reads.
   *
   * Each knot span of the curve is one smooth piece. A piece is replaced by
   * the cubic through its end points with its end tangents (Hermite), and
   * halved until that cubic stays within `tolerance` of it — compared at
   * equal parameters, which bounds the distance between the two curves. The
   * pieces are joined with a double knot where the curve's tangent runs
   * through (C1) and a triple knot where it has a corner, so the result has
   * the curve's own smoothness and passes exactly through its ends and
   * every breakpoint.
   */
  static toCubic(curve: BSpline, tolerance: number): BSpline {
    if (curve.degree <= 3 && !curve.weights) {
      return curve;
    }
    type Piece = { a: number; b: number; p0: Vec2; p1: Vec2; d0: Vec2; d1: Vec2 };
    const { degree, knots, poles } = curve;
    const pieces: Piece[] = [];

    const fit = (span: number, a: number, b: number, depth: number): void => {
      const start = BSplineCurve2D.evaluateSpan(curve, span, a);
      const end = BSplineCurve2D.evaluateSpan(curve, span, b);
      const h = b - a;
      const c1 = { x: start.point.x + (start.derivative.x * h) / 3, y: start.point.y + (start.derivative.y * h) / 3 };
      const c2 = { x: end.point.x - (end.derivative.x * h) / 3, y: end.point.y - (end.derivative.y * h) / 3 };
      let worst = 0;
      for (let i = 1; i < HERMITE_CHECKS; i++) {
        const s = i / HERMITE_CHECKS;
        const r = 1 - s;
        const k0 = r * r * r;
        const k1 = 3 * r * r * s;
        const k2 = 3 * r * s * s;
        const k3 = s * s * s;
        const exact = BSplineCurve2D.evaluateSpan(curve, span, a + h * s).point;
        const x = k0 * start.point.x + k1 * c1.x + k2 * c2.x + k3 * end.point.x;
        const y = k0 * start.point.y + k1 * c1.y + k2 * c2.y + k3 * end.point.y;
        worst = Math.max(worst, Math.hypot(x - exact.x, y - exact.y));
      }
      if (worst > tolerance && depth < HERMITE_MAX_DEPTH) {
        const mid = (a + b) / 2;
        fit(span, a, mid, depth + 1);
        fit(span, mid, b, depth + 1);
        return;
      }
      pieces.push({ a, b, p0: start.point, p1: end.point, d0: start.derivative, d1: end.derivative });
    };
    for (let span = degree; span < poles.length; span++) {
      if (knots[span + 1] > knots[span]) {
        fit(span, knots[span], knots[span + 1], 0);
      }
    }

    const first = pieces[0];
    const cubicKnots: number[] = [first.a, first.a, first.a, first.a];
    const cubicPoles: Vec2[] = [first.p0];
    pieces.forEach((piece, index) => {
      const h = piece.b - piece.a;
      cubicPoles.push(
        { x: piece.p0.x + (piece.d0.x * h) / 3, y: piece.p0.y + (piece.d0.y * h) / 3 },
        { x: piece.p1.x - (piece.d1.x * h) / 3, y: piece.p1.y - (piece.d1.y * h) / 3 },
      );
      const next = pieces[index + 1];
      if (!next) {
        cubicPoles.push(piece.p1);
        cubicKnots.push(piece.b, piece.b, piece.b, piece.b);
        return;
      }
      // The tangent runs through the joint: the joint point is implied by
      // its two neighbours and a double knot. A corner keeps its point.
      const jump = Math.hypot(next.d0.x - piece.d1.x, next.d0.y - piece.d1.y);
      const size = Math.max(Math.hypot(piece.d1.x, piece.d1.y), Math.hypot(next.d0.x, next.d0.y));
      if (jump <= size * TANGENT_JOIN_RELATIVE) {
        cubicKnots.push(piece.b, piece.b);
      } else {
        cubicPoles.push(piece.p1);
        cubicKnots.push(piece.b, piece.b, piece.b);
      }
    });
    return { kind: 'bspline', degree: 3, knots: cubicKnots, poles: cubicPoles };
  }

  /**
   * The point and first derivative at `u` of the polynomial (or rational)
   * piece the curve has on knot span `span` (`knots[span] < knots[span + 1]`).
   * The piece is evaluated as itself, so `u` at the span's end gives the
   * value and tangent *arriving* there — at a corner, the left ones.
   */
  static evaluateSpan(curve: BSpline, span: number, u: number): { point: Vec2; derivative: Vec2 } {
    const { degree, knots, poles, weights } = curve;
    // Homogeneous control points of the span: (w·x, w·y, w).
    const h: number[][] = [];
    for (let j = 0; j <= degree; j++) {
      const index = span - degree + j;
      const w = weights ? weights[index] : 1;
      h.push([poles[index].x * w, poles[index].y * w, w]);
    }
    // The derivative's control points, one degree down on the same span.
    const d: number[][] = [];
    for (let j = 0; j < degree; j++) {
      const index = span - degree + j;
      const width = knots[index + degree + 1] - knots[index + 1];
      const scale = width === 0 ? 0 : degree / width;
      d.push([(h[j + 1][0] - h[j][0]) * scale, (h[j + 1][1] - h[j][1]) * scale, (h[j + 1][2] - h[j][2]) * scale]);
    }
    const value = BSplineCurve2D.deBoor(knots, degree, span, h, u);
    // The derivative curve drops the first and last knot: its span index is one less.
    const slope = BSplineCurve2D.deBoor(knots.slice(1, -1), degree - 1, span - 1, d, u);
    const point = { x: value[0] / value[2], y: value[1] / value[2] };
    return {
      point,
      // Quotient rule on (A / w): (A' − w'·P) / w.
      derivative: { x: (slope[0] - slope[2] * point.x) / value[2], y: (slope[1] - slope[2] * point.y) / value[2] },
    };
  }

  /**
   * The curve as Bézier segments, exactly: one per knot span it has length
   * on, each `degree + 1` control points from the span's start to its end —
   * what an SVG path's `L` (degree 1), `Q` (2) and `C` (3) commands take.
   * Only for a non-rational curve: a rational piece has no polynomial
   * Bézier form ({@link toCubic} gives one within a tolerance first).
   *
   * Control point `i` of a span `[a, b]` is the curve's blossom at `a`
   * taken `degree − i` times and `b` taken `i` times — the same values full
   * knot insertion at both ends would leave, without rebuilding the curve.
   */
  static bezierSegments(curve: BSpline): Vec2[][] {
    if (curve.weights) {
      throw new Error('A rational B-spline has no exact Bézier segments');
    }
    const { degree, knots, poles } = curve;
    const segments: Vec2[][] = [];
    for (let span = degree; span < poles.length; span++) {
      const a = knots[span];
      const b = knots[span + 1];
      if (!(b > a)) {
        continue;
      }
      const control: number[][] = [];
      for (let j = 0; j <= degree; j++) {
        control.push([poles[span - degree + j].x, poles[span - degree + j].y]);
      }
      const segment: Vec2[] = [];
      for (let i = 0; i <= degree; i++) {
        const args: number[] = [];
        for (let r = 0; r < degree; r++) {
          args.push(r < degree - i ? a : b);
        }
        const point = BSplineCurve2D.blossom(knots, degree, span, control, args);
        segment.push({ x: point[0], y: point[1] });
      }
      segments.push(segment);
    }
    return segments;
  }

  /**
   * The blossom (polar form) of the piece on `span` at `args` — de Boor's
   * recursion with its own argument at each of the `degree` levels. With
   * every argument equal it is the point on the curve.
   */
  private static blossom(knots: readonly number[], degree: number, span: number, control: number[][], args: readonly number[]): number[] {
    const points = control.map((point) => [...point]);
    for (let r = 1; r <= degree; r++) {
      const u = args[r - 1];
      for (let j = degree; j >= r; j--) {
        const index = span - degree + j;
        const width = knots[index + degree - r + 1] - knots[index];
        const alpha = width === 0 ? 0 : (u - knots[index]) / width;
        for (let axis = 0; axis < points[j].length; axis++) {
          points[j][axis] = (1 - alpha) * points[j - 1][axis] + alpha * points[j][axis];
        }
      }
    }
    return points[degree];
  }

  /** De Boor on one span: `control` are the span's `degree + 1` points, any dimension. */
  private static deBoor(knots: readonly number[], degree: number, span: number, control: number[][], u: number): number[] {
    const points = control.map((point) => [...point]);
    for (let r = 1; r <= degree; r++) {
      for (let j = degree; j >= r; j--) {
        const index = span - degree + j;
        const width = knots[index + degree - r + 1] - knots[index];
        const alpha = width === 0 ? 0 : (u - knots[index]) / width;
        for (let axis = 0; axis < points[j].length; axis++) {
          points[j][axis] = (1 - alpha) * points[j - 1][axis] + alpha * points[j][axis];
        }
      }
    }
    return points[degree];
  }
}
