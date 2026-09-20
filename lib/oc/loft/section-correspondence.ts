import type { Geom_BSplineCurve } from 'ocjs-fluidcad';
import { getOC } from '../init.js';
import type { WireSection } from './section-curve.js';

/** Automatic cyclic correspondence of genuine profile corners. */
export class SectionCorrespondence {
  /** Matches SectionCompatibility's threshold for a sharp profile corner. */
  private static readonly CORNER_ANGLE = 0.01;

  /**
   * Parameters have already followed any winding reversals. Match whole
   * corner cycles, rather than the nearest point (or nearest corner) to a
   * single seam. A narrow rotated rectangle otherwise matches a short side
   * to a long one. Smooth and unequal-corner profiles retain seam matching.
   */
  static parameters(
    sections: WireSection[], curves: Geom_BSplineCurve[], parameters: number[][],
  ): number[][] | undefined {
    const corners = sections.map((section, k) => section.vertices
      .map((vertex, i) => ({ point: vertex.point, parameter: parameters[k][i] }))
      .filter(vertex => SectionCorrespondence.isCorner(curves[k], vertex.parameter))
      .sort((a, b) => a.parameter - b.parameter));
    const count = corners[0].length;
    if (count < 2 || corners.some(row => row.length !== count)) {
      return undefined;
    }

    for (let k = 1; k < corners.length; k++) {
      const previous = corners[k - 1];
      const current = corners[k];
      // Translation contributes the same constant to every cyclic cost.
      // Remove it so distant sections cannot swamp the corner differences.
      const advance = [0, 0, 0];
      for (let i = 0; i < count; i++) {
        advance[0] += (current[i].point.x - previous[i].point.x) / count;
        advance[1] += (current[i].point.y - previous[i].point.y) / count;
        advance[2] += (current[i].point.z - previous[i].point.z) / count;
      }
      let bestShift = 0;
      let bestCost = Infinity;
      for (let shift = 0; shift < count; shift++) {
        let cost = 0;
        for (let i = 0; i < count; i++) {
          const a = previous[i].point;
          const b = current[(i + shift) % count].point;
          cost += (b.x - a.x - advance[0]) ** 2
            + (b.y - a.y - advance[1]) ** 2 + (b.z - a.z - advance[2]) ** 2;
        }
        // Keep traversal order as the deterministic tie-break for symmetry.
        if (!Number.isFinite(bestCost) || cost < bestCost - 1e-12 * Math.max(bestCost, cost)) {
          bestCost = cost;
          bestShift = shift;
        }
      }
      corners[k] = [...current.slice(bestShift), ...current.slice(0, bestShift)];
    }
    return corners.map(row => row.map(vertex => vertex.parameter));
  }

  private static isCorner(curve: Geom_BSplineCurve, u: number): boolean {
    const oc = getOC();
    const point = new oc.gp_Pnt();
    const before = new oc.gp_Vec();
    const after = new oc.gp_Vec();
    try {
      // Stay inside the adjoining knot spans, including the closing seam.
      const knots = [0];
      for (let i = 2; i <= curve.NbKnots(); i++) {
        knots.push(curve.Knot(i));
      }
      const left = u === 0 ? knots.at(-2)! - 1 : [...knots].reverse().find(t => t < u - 1e-9) ?? 0;
      const right = knots.find(t => t > u + 1e-9) ?? 1;
      const step = Math.min(u - left, right - u) * 1e-4;
      curve.D1(u === 0 ? 1 - step : u - step, point, before);
      curve.D1(u + step, point, after);
      const scale = before.Magnitude() * after.Magnitude();
      if (scale === 0) {
        return false;
      }
      const cosine = Math.min(1, Math.max(-1, before.Dot(after) / scale));
      return Math.acos(cosine) > SectionCorrespondence.CORNER_ANGLE;
    } finally {
      point.delete();
      before.delete();
      after.delete();
    }
  }
}
