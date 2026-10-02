import type { gp_Ax2, TopoDS_Edge } from "ocjs-fluidcad";
import { getOC } from "../init.js";
import { mmTol } from "../../units/tolerance.js";
import type { RationalBSplineData } from "./curve-data.js";

/** A circle or ellipse in space: p(θ) = center + cos θ · major + sin θ · minor. */
export interface ConicFrame {
  center: number[];
  /** Semi-axis vectors (radius × unit direction), orthogonal. */
  major: number[];
  minor: number[];
}

/** A stretch of a conic traversed from angle `from` to angle `to` — decreasing when clockwise. */
export interface ConicArc {
  frame: ConicFrame;
  from: number;
  to: number;
}

/**
 * Circles and ellipses as exact rational B-splines made of ONE span.
 *
 * The kernel's default conversion (t = tan θ/2) needs a span per 120° and
 * joins them with knots of full multiplicity: the curve is round, but
 * formally only C0 there. A loft wall skinned through it inherits those
 * knots, and OCC's offset refuses any face whose surface is C0 — a shell of
 * a round loft failed at every thickness.
 *
 * Squaring a half-angle curve h(τ) = (U, V) doubles its angle, so
 *
 *   cos θ = (U² − V²) / (U² + V²),   sin θ = 2UV / (U² + V²)
 *
 * is on the circle for ANY polynomials U, V. With U = 1 + bτ² and
 * V = τ + cτ³ fitted to tan τ (OCC's "quasi-angular" form, c = b + 1/3, b
 * making V/U = tan τ at the ends), one degree-6 span covers any sweep up to
 * a full turn with positive weights, and its parameter follows the angle —
 * to a fifth of a degree over a full turn, a hundredth of that over half of
 * one. So a conic has no interior knot at all, and sections are matched by
 * angle rather than by tan θ/2.
 */
export class ConicArcs {
  private static readonly DEGREE = 6;
  private static readonly TURN = 2 * Math.PI;
  /** Sweeps closer than this (radians) are the same; so are axes whose cosine is this close to 1. */
  private static readonly ANGLE_TOLERANCE = 1e-9;
  private static get POINT_TOLERANCE(): number {
    return mmTol(1e-7);
  }

  /** The conic an edge lies on and the stretch it covers in traversal order, or null for any other curve. */
  static ofEdge(edge: TopoDS_Edge): ConicArc | null {
    const oc = getOC();
    const adaptor = new oc.BRepAdaptor_Curve(edge);
    try {
      const type = adaptor.GetType();
      let position: gp_Ax2;
      let majorRadius: number;
      let minorRadius: number;
      if (type === oc.GeomAbs_CurveType.GeomAbs_Circle) {
        const circle = adaptor.Circle();
        position = circle.Position();
        majorRadius = minorRadius = circle.Radius();
        circle.delete();
      } else if (type === oc.GeomAbs_CurveType.GeomAbs_Ellipse) {
        const ellipse = adaptor.Ellipse();
        position = ellipse.Position();
        majorRadius = ellipse.MajorRadius();
        minorRadius = ellipse.MinorRadius();
        ellipse.delete();
      } else {
        return null;
      }

      const location = position.Location();
      const x = position.XDirection();
      const y = position.YDirection();
      const frame: ConicFrame = {
        center: [location.X(), location.Y(), location.Z()],
        major: [x.X() * majorRadius, x.Y() * majorRadius, x.Z() * majorRadius],
        minor: [y.X() * minorRadius, y.Y() * minorRadius, y.Z() * minorRadius],
      };
      location.delete();
      x.delete();
      y.delete();
      position.delete();

      const first = adaptor.FirstParameter();
      const last = adaptor.LastParameter();
      const sweep = last - first;
      if (!(sweep > ConicArcs.ANGLE_TOLERANCE) || sweep > ConicArcs.TURN + ConicArcs.ANGLE_TOLERANCE) {
        return null;
      }

      // The frame must reproduce the edge itself: a placement this reading
      // does not model falls back to the kernel's own conversion.
      for (const angle of [first, (first + last) / 2, last]) {
        const actual = adaptor.Value(angle);
        const expected = ConicArcs.pointAt(frame, angle);
        const gap = Math.hypot(actual.X() - expected[0], actual.Y() - expected[1], actual.Z() - expected[2]);
        actual.delete();
        if (gap > ConicArcs.POINT_TOLERANCE) {
          return null;
        }
      }

      const reversed = edge.Orientation() === oc.TopAbs_Orientation.TopAbs_REVERSED;
      return { frame, from: reversed ? last : first, to: reversed ? first : last };
    } finally {
      adaptor.delete();
    }
  }

  static pointAt(frame: ConicFrame, angle: number): number[] {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return frame.center.map((c, d) => c + cos * frame.major[d] + sin * frame.minor[d]);
  }

  static sweep(arc: ConicArc): number {
    return Math.abs(arc.to - arc.from);
  }

  /** Whether the arc is the whole conic. */
  static isFullTurn(arc: ConicArc): boolean {
    return Math.abs(ConicArcs.sweep(arc) - ConicArcs.TURN) <= ConicArcs.ANGLE_TOLERANCE;
  }

  /**
   * `arc` grown by `next` when `next` carries on along the same conic, in the
   * same sense, from where `arc` ends; null otherwise. The two frames may
   * differ (another start axis, a flipped normal) as long as the conic is
   * the same.
   */
  static extend(arc: ConicArc, next: ConicArc): ConicArc | null {
    const tolerance = ConicArcs.POINT_TOLERANCE;
    const a = arc.frame;
    const b = next.frame;
    const length = (v: number[]) => Math.hypot(v[0], v[1], v[2]);
    const dot = (u: number[], v: number[]) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
    const cross = (u: number[], v: number[]) => [
      u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0],
    ];

    if (length(a.center.map((c, d) => c - b.center[d])) > tolerance) {
      return null;
    }
    const [aMajor, aMinor, bMajor, bMinor] = [length(a.major), length(a.minor), length(b.major), length(b.minor)];
    if (Math.abs(aMajor - bMajor) > tolerance || Math.abs(aMinor - bMinor) > tolerance) {
      return null;
    }
    const aNormal = cross(a.major, a.minor);
    const bNormal = cross(b.major, b.minor);
    const alignment = dot(aNormal, bNormal) / (length(aNormal) * length(bNormal));
    if (Math.abs(alignment) < 1 - ConicArcs.ANGLE_TOLERANCE) {
      return null;
    }
    // An ellipse also fixes where its long axis points; a circle does not.
    if (Math.abs(aMajor - aMinor) > tolerance
      && Math.abs(dot(a.major, b.major)) / (aMajor * bMajor) < 1 - ConicArcs.ANGLE_TOLERANCE) {
      return null;
    }

    const sense = Math.sign(arc.to - arc.from);
    const nextSense = Math.sign(next.to - next.from) * Math.sign(alignment);
    if (sense !== nextSense) {
      return null;
    }
    const end = ConicArcs.pointAt(a, arc.to);
    const start = ConicArcs.pointAt(b, next.from);
    if (length(end.map((c, d) => c - start[d])) > tolerance) {
      return null;
    }

    const to = arc.to + sense * ConicArcs.sweep(next);
    if (Math.abs(to - arc.from) > ConicArcs.TURN + ConicArcs.ANGLE_TOLERANCE) {
      return null;
    }
    return { frame: a, from: arc.from, to };
  }

  /** The arc as one rational degree-6 span over [0, 1], from `from` to `to`. */
  static toBSpline(arc: ConicArc): RationalBSplineData {
    const { u, v } = ConicArcs.halfAngle(ConicArcs.sweep(arc) / 4);
    const uu = ConicArcs.multiply(u, u);
    const vv = ConicArcs.multiply(v, v);
    const uv = ConicArcs.multiply(u, v);

    // The half-angle curve runs symmetrically about the arc's middle.
    const middle = (arc.from + arc.to) / 2;
    const sense = Math.sign(arc.to - arc.from);
    const cosMiddle = Math.cos(middle);
    const sinMiddle = Math.sin(middle);

    const poles: number[][] = [];
    const weights: number[] = [];
    for (let i = 0; i <= ConicArcs.DEGREE; i++) {
      const weight = uu[i] + vv[i];
      if (!(weight > 0)) {
        throw new Error("Loft internal error: conic section produced a non-positive weight.");
      }
      const cos = (uu[i] - vv[i]) / weight;
      const sin = sense * 2 * uv[i] / weight;
      const x = cos * cosMiddle - sin * sinMiddle;
      const y = cos * sinMiddle + sin * cosMiddle;
      poles.push(arc.frame.center.map((c, d) => c + x * arc.frame.major[d] + y * arc.frame.minor[d]));
      weights.push(weight);
    }

    const scale = 1 / weights[0];
    return {
      poles,
      weights: weights.map(weight => weight * scale),
      knots: [0, 1],
      multiplicities: [ConicArcs.DEGREE + 1, ConicArcs.DEGREE + 1],
      degree: ConicArcs.DEGREE,
    };
  }

  /** Parameter in [0, 1] at which `toBSpline(arc)` reaches `angle`. */
  static parameterAt(arc: ConicArc, angle: number): number {
    const gamma = ConicArcs.sweep(arc) / 4;
    const sense = Math.sign(arc.to - arc.from);
    const half = sense * (angle - (arc.from + arc.to) / 2) / 2;
    const { b, c } = ConicArcs.fit(gamma);
    const cos = Math.cos(half);
    const sin = Math.sin(half);

    // tan(half) = V(x) / U(x), with U = 1 + b·x², V = γ·x·(1 + c·x²) on [-1, 1].
    let x = Math.min(1, Math.max(-1, half / gamma));
    for (let iteration = 0; iteration < 50; iteration++) {
      const value = gamma * x * (1 + c * x * x) * cos - (1 + b * x * x) * sin;
      const slope = gamma * (1 + 3 * c * x * x) * cos - 2 * b * x * sin;
      const step = value / slope;
      x = Math.min(1, Math.max(-1, x - step));
      if (Math.abs(step) < 1e-16) {
        break;
      }
    }
    return (x + 1) / 2;
  }

  /**
   * Poles of a curve lying on the whole conic, turned along it so the curve
   * starts where `to` is instead of where `from` is. Turning the conic onto
   * itself is an affine map, which leaves knots and weights alone — unlike
   * cutting the curve at the new start and gluing the halves back, which
   * leaves a knot at the old start and weights no other section shares.
   */
  static turn(poles: number[][], frame: ConicFrame, from: number[], to: number[]): number[][] {
    const majorSquared = frame.major.reduce((sum, v) => sum + v * v, 0);
    const minorSquared = frame.minor.reduce((sum, v) => sum + v * v, 0);
    const local = (point: number[]) => {
      const offset = point.map((c, d) => c - frame.center[d]);
      return [
        offset.reduce((sum, v, d) => sum + v * frame.major[d], 0) / majorSquared,
        offset.reduce((sum, v, d) => sum + v * frame.minor[d], 0) / minorSquared,
      ];
    };
    const [fromX, fromY] = local(from);
    const [toX, toY] = local(to);
    const angle = Math.atan2(toY, toX) - Math.atan2(fromY, fromX);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);

    return poles.map(pole => {
      const [x, y] = local(pole);
      // Whatever sits off the conic's plane (nothing, for a planar profile) rides along.
      const rest = pole.map((c, d) => c - frame.center[d] - x * frame.major[d] - y * frame.minor[d]);
      const turnedX = x * cos - y * sin;
      const turnedY = x * sin + y * cos;
      return frame.center.map((c, d) => c + turnedX * frame.major[d] + turnedY * frame.minor[d] + rest[d]);
    });
  }

  /**
   * U and V of the half-angle curve as cubic Bernstein coefficients over
   * [-γ, γ]. In x = τ/γ: U = 1 + b·x², V = γ·x·(1 + c·x²).
   */
  private static halfAngle(gamma: number): { u: number[]; v: number[] } {
    const { b, c } = ConicArcs.fit(gamma);
    return {
      u: [1 + b, 1 - b / 3, 1 - b / 3, 1 + b],
      v: [-1 - c, -1 / 3 + c, 1 / 3 - c, 1 + c].map(value => value * gamma),
    };
  }

  /**
   * The fit of V/U to tan τ: c − b = γ²/3 matches the series of tan, and b
   * makes V/U = tan γ exactly at the ends, so the arc spans its sweep to
   * the last digit. At γ = π/2 (a full turn) U vanishes at both ends.
   */
  private static fit(gamma: number): { b: number; c: number } {
    const squared = gamma * gamma;
    // The closed form loses its digits to cancellation as γ → 0.
    const b = gamma < 0.1
      ? -squared * (2 / 5 + squared * (1 / 525 + squared * 2 / 23625))
      : gamma * squared / (3 * (Math.tan(gamma) - gamma)) - 1;
    return { b, c: squared / 3 + b };
  }

  /** Product of two cubic Bernstein polynomials, as degree-6 Bernstein coefficients. */
  private static multiply(f: number[], g: number[]): number[] {
    const cubic = [1, 3, 3, 1];
    const sextic = [1, 6, 15, 20, 15, 6, 1];
    const product = new Array<number>(7).fill(0);
    for (let i = 0; i <= 3; i++) {
      for (let j = 0; j <= 3; j++) {
        product[i + j] += cubic[i] * cubic[j] * f[i] * g[j] / sextic[i + j];
      }
    }
    return product;
  }
}
