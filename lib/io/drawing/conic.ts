import type { Curve2D, Vec2 } from "./drawing.js";
import { Curves } from "./drawing.js";

const TWO_PI = 2 * Math.PI;

/** A sweep this close to a full turn is the whole curve. unit: angular */
const FULL_TURN_TOL = 1e-9;

/**
 * Every projected circle and ellipse, through one door.
 *
 * A circle or ellipse in space is `C + cos t · U + sin t · V`. An
 * orthographic projection is an affine map, so on the drawing plane it is
 * still `c + cos t · u + sin t · v` with `u`, `v` the projected axis vectors
 * — a pair of conjugate semi-diameters, in general neither perpendicular nor
 * the principal axes. This recovers the principal form, and with it the three
 * things a projection can turn a conic into: a circle (seen square-on), an
 * ellipse (tilted), a straight segment (edge-on).
 */
export class Conic {
  /**
   * The curve `c + cos t · u + sin t · v` for `t` in `[t0, t1]`
   * (`t0 < t1 <= t0 + 2π`), as a counter-clockwise circle, arc or ellipse,
   * or the segment it folds onto when the two vectors are parallel. Null
   * when it collapses to a point. `tolerance` is a length.
   */
  static fromConjugateDiameters(c: Vec2, u: Vec2, v: Vec2, t0: number, t1: number, tolerance: number): Curve2D | null {
    const sweep = Math.min(t1 - t0, TWO_PI);
    if (!(sweep > 0)) {
      return null;
    }
    const full = sweep >= TWO_PI - FULL_TURN_TOL;

    // Principal axes: the eigenvectors of M·Mᵀ for M = [u v]; its eigenvalues
    // are the squared semi-axes.
    const sxx = u.x * u.x + v.x * v.x;
    const sxy = u.x * u.y + v.x * v.y;
    const syy = u.y * u.y + v.y * v.y;
    const mean = (sxx + syy) / 2;
    const spread = Math.hypot((sxx - syy) / 2, sxy);
    const a = Math.sqrt(Math.max(0, mean + spread));
    const b = Math.sqrt(Math.max(0, mean - spread));

    if (a <= tolerance) {
      return null;
    }

    // Seen square-on (or a sphere's outline): any direction is principal.
    if (a - b <= tolerance) {
      const radius = (a + b) / 2;
      if (full) {
        return { kind: 'circle', center: c, radius };
      }
      const angleAt = (t: number) => Math.atan2(
        Math.cos(t) * u.y + Math.sin(t) * v.y,
        Math.cos(t) * u.x + Math.sin(t) * v.x,
      );
      const ccw = u.x * v.y - u.y * v.x > 0;
      const start = Curves.normalizeAngle(angleAt(ccw ? t0 : t1));
      return { kind: 'arc', center: c, radius, start, end: start + sweep };
    }

    // The major direction: the eigenvector of the larger eigenvalue, taken
    // from whichever row of (S − λ₂·I) is better conditioned.
    const lambda2 = mean - spread;
    let mx = sxx - lambda2;
    let my = sxy;
    if (Math.abs(sxy) + Math.abs(syy - lambda2) > Math.abs(mx) + Math.abs(my)) {
      mx = sxy;
      my = syy - lambda2;
    }
    const mLength = Math.hypot(mx, my);
    mx /= mLength;
    my /= mLength;

    // Edge-on: the curve folds onto the major direction. Its reach along it
    // is A·cos(t − φ), whose extremes inside the range are at φ + kπ — the
    // fold can turn around between the two ends.
    if (b <= tolerance) {
      const ux = u.x * mx + u.y * my;
      const vx = v.x * mx + v.y * my;
      const phi = Math.atan2(vx, ux);
      const reach = Math.hypot(ux, vx);
      const along = (t: number) => reach * Math.cos(t - phi);
      let min = Math.min(along(t0), along(t0 + sweep));
      let max = Math.max(along(t0), along(t0 + sweep));
      const firstK = Math.ceil((t0 - phi) / Math.PI - 1e-9); // unit: angular
      const lastK = Math.floor((t0 + sweep - phi) / Math.PI + 1e-9); // unit: angular
      for (let k = firstK; k <= lastK; k++) {
        const value = along(phi + k * Math.PI);
        min = Math.min(min, value);
        max = Math.max(max, value);
      }
      if (max - min <= tolerance) {
        return null;
      }
      return {
        kind: 'line',
        a: { x: c.x + mx * min, y: c.y + my * min },
        b: { x: c.x + mx * max, y: c.y + my * max },
      };
    }

    // Tilted: an ellipse. In the principal frame (major, perp(major)) the
    // point at t sits at ellipse parameter s(t) = ±(t − δ): the sense is the
    // sign of det [u v], and a clockwise run is the counter-clockwise one
    // read from its other end.
    const paramAt = (t: number) => {
      const qx = Math.cos(t) * u.x + Math.sin(t) * v.x;
      const qy = Math.cos(t) * u.y + Math.sin(t) * v.y;
      return Math.atan2((-qx * my + qy * mx) / b, (qx * mx + qy * my) / a);
    };
    const major = { x: mx * a, y: my * a };
    const ratio = b / a;
    if (full) {
      return { kind: 'ellipse', center: c, major, ratio, start: 0, end: TWO_PI };
    }
    const ccw = u.x * v.y - u.y * v.x > 0;
    const start = Curves.normalizeAngle(paramAt(ccw ? t0 : t1));
    return { kind: 'ellipse', center: c, major, ratio, start, end: start + sweep };
  }
}
