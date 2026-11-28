import { Edge } from "../common/edge.js";
import { BuildError } from "../common/build-error.js";
import type { CurveEnd } from "../helpers/curve-end.js";
import { Point } from "../math/point.js";
import { mmTol } from "../units/tolerance.js";
import { EdgeOps } from "./edge-ops.js";
import { Geometry } from "./geometry.js";

/** How a bridge meets each end: position, tangent or curvature. */
export type BridgeContinuity = 'g0' | 'g1' | 'g2';

/** The derivative constraints each continuity asks for at an end. */
const ORDER: Record<BridgeContinuity, number> = { g0: 0, g1: 1, g2: 2 };

/**
 * The bridge curve: one Bezier between two curve ends that leaves `from`
 * the way its curve was heading and arrives at `to` heading into its curve,
 * matching position, tangent or curvature at each.
 *
 * With `P0`, `P1` the end points, `L = |P1 − P0|`, `T0`, `T1` the outward
 * tangents, `K0`, `K1` the curvature vectors and `s0 = startMagnitude · L`,
 * `s1 = endMagnitude · L` the speed at each end, an end takes `c` derivative
 * constraints — the lower of what the continuity asks (0, 1, 2) and what
 * the end offers (a bare point offers none) — and the curve has degree
 * `n = c0 + c1 + 1`, poles `Q0 … Qn`:
 *
 * - `Q0 = P0`; `Q1 = Q0 + (s0 / n) · T0` when `c0 ≥ 1`;
 *   `Q2 = 2·Q1 − Q0 + (s0² / (n(n−1))) · K0` when `c0 = 2`;
 * - `Qn = P1`; `Qn−1 = Qn + (s1 / n) · T1` when `c1 ≥ 1`;
 *   `Qn−2 = 2·Qn−1 − Qn + (s1² / (n(n−1))) · K1` when `c1 = 2`.
 *
 * They follow from a Bezier's end derivatives, `B′(0) = n(Q1 − Q0)` and
 * `B″(0) = n(n−1)(Q2 − 2Q1 + Q0)`: the curve leaves at speed `s0` along
 * `T0` with second derivative `s0² K0`, which has no part along the
 * tangent, so its curvature there is `K0`. `Qn−1` sits behind `P1` along
 * `T1`, the outward direction of the `to` curve, so the bridge arrives
 * heading into it. Position at both ends is a straight line (`n = 1`),
 * built as one.
 */
export class BridgeOps {

  /** The bridge between two ends, as an edge. Coincident ends are refused before anything is built. */
  static make(from: CurveEnd, to: CurveEnd, continuity: BridgeContinuity, startMagnitude: number, endMagnitude: number): Edge {
    const poles = BridgeOps.poles(from, to, continuity, startMagnitude, endMagnitude);
    if (poles.length === 2) {
      return EdgeOps.makeLineEdge(poles[0], poles[1]);
    }
    const curve = Geometry.makeBezierCurve(poles);
    try {
      return Geometry.makeEdgeFromBezier(curve);
    } finally {
      // The edge holds its own handle to the curve.
      curve.delete();
    }
  }

  /** The poles `Q0 … Qn` of the bridge (see the class comment). Coincident ends are refused. */
  static poles(from: CurveEnd, to: CurveEnd, continuity: BridgeContinuity, startMagnitude: number, endMagnitude: number): Point[] {
    const length = from.point.distanceTo(to.point);
    if (length < mmTol(1e-6)) {
      throw new BuildError(
        `bridge: the two ends are at the same point.`,
        `A bridge joins two ends apart from each other: pick the end of another curve, or a point elsewhere.`,
      );
    }
    const c0 = BridgeOps.constraintsAt(from, continuity);
    const c1 = BridgeOps.constraintsAt(to, continuity);
    const n = c0 + c1 + 1;
    const s0 = startMagnitude * length;
    const s1 = endMagnitude * length;

    const poles: Point[] = new Array(n + 1);
    poles[0] = from.point;
    poles[n] = to.point;
    if (c0 >= 1) {
      poles[1] = poles[0].add(from.tangent!.multiply(s0 / n));
    }
    if (c0 === 2) {
      poles[2] = poles[1].add(poles[0].vectorTo(poles[1])).add(from.curvature!.multiply((s0 * s0) / (n * (n - 1))));
    }
    if (c1 >= 1) {
      poles[n - 1] = poles[n].add(to.tangent!.multiply(s1 / n));
    }
    if (c1 === 2) {
      poles[n - 2] = poles[n - 1].add(poles[n].vectorTo(poles[n - 1])).add(to.curvature!.multiply((s1 * s1) / (n * (n - 1))));
    }
    return poles;
  }

  /** How many derivatives an end is matched to: what the continuity asks, at most what the end offers. */
  private static constraintsAt(end: CurveEnd, continuity: BridgeContinuity): number {
    const offered = end.tangent ? (end.curvature ? 2 : 1) : 0;
    return Math.min(ORDER[continuity], offered);
  }
}
