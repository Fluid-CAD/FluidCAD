import type { Geom_BSplineCurve } from 'ocjs-fluidcad';
import { getOC } from '../init.js';
import type { WireSection } from './section-curve.js';
import type { Point } from '../../math/point.js';

/** A wire vertex the surface changes character at: a tangent kink, or a tangent junction where the curvature jumps. */
type FeatureKind = 'corner' | 'joint';

interface Feature {
  point: Point;
  parameter: number;
  kind: FeatureKind;
}

/**
 * Automatic cyclic correspondence of profile vertices: sections with the
 * same vertices in the same order are joined vertex to vertex, the way
 * every edge-matching loft does — a rounded rectangle lofts to another one
 * flat to flat and arc to arc, whatever their radii. Left to parameter
 * alone, each junction of one section lands mid-edge on the next, and the
 * wall is cut into twice the faces it needs.
 */
export class SectionCorrespondence {
  /** Matches SectionCompatibility's threshold for a sharp profile corner. */
  private static readonly CORNER_ANGLE = 0.01;
  /** Matches SectionCompatibility's threshold for a curvature jump. */
  private static readonly CURVATURE_JUMP = 0.3;

  /**
   * Parameters have already followed any winding reversals. Match whole
   * vertex cycles, rather than the nearest point (or nearest vertex) to a
   * single seam. A narrow rotated rectangle otherwise matches a short side
   * to a long one.
   *
   * Every feature vertex is matched when the sections agree on them — the
   * same number, corners facing corners and joints facing joints. Failing
   * that the corners alone are, when their number agrees. Smooth profiles
   * and profiles with unequal vertices retain seam matching.
   */
  static parameters(
    sections: WireSection[], curves: Geom_BSplineCurve[], parameters: number[][],
  ): number[][] | undefined {
    const features = sections.map((section, k) => section.vertices
      .map((vertex, i) => ({
        point: vertex.point,
        parameter: parameters[k][i],
        kind: SectionCorrespondence.kindOf(curves[k], parameters[k][i]),
      }))
      .filter((vertex): vertex is Feature => vertex.kind !== null)
      .sort((a, b) => a.parameter - b.parameter));

    return SectionCorrespondence.match(features, true)
      ?? SectionCorrespondence.match(features.map(row => row.filter(feature => feature.kind === 'corner')), false);
  }

  /**
   * The cyclic shift of each section that brings its features nearest the
   * previous section's, as rows of matching parameters. Undefined when the
   * sections disagree on how many there are — or, with `sameKinds`, on
   * which is a corner and which a joint under every shift.
   */
  private static match(features: Feature[][], sameKinds: boolean): number[][] | undefined {
    const count = features[0].length;
    if (count < 2 || features.some(row => row.length !== count)) {
      return undefined;
    }

    const matched = features.map(row => [...row]);
    for (let k = 1; k < matched.length; k++) {
      const previous = matched[k - 1];
      const current = matched[k];
      // Translation contributes the same constant to every cyclic cost.
      // Remove it so distant sections cannot swamp the vertex differences.
      const advance = [0, 0, 0];
      for (let i = 0; i < count; i++) {
        advance[0] += (current[i].point.x - previous[i].point.x) / count;
        advance[1] += (current[i].point.y - previous[i].point.y) / count;
        advance[2] += (current[i].point.z - previous[i].point.z) / count;
      }
      let bestShift = -1;
      let bestCost = Infinity;
      for (let shift = 0; shift < count; shift++) {
        if (sameKinds && previous.some((feature, i) => feature.kind !== current[(i + shift) % count].kind)) {
          continue;
        }
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
      if (bestShift < 0) {
        return undefined;
      }
      matched[k] = [...current.slice(bestShift), ...current.slice(0, bestShift)];
    }
    return matched.map(row => row.map(feature => feature.parameter));
  }

  /** What the curve does at a vertex: turns (corner), changes curvature (joint), or just carries on (null). */
  private static kindOf(curve: Geom_BSplineCurve, u: number): FeatureKind | null {
    const oc = getOC();
    const point = new oc.gp_Pnt();
    const first = new oc.gp_Vec();
    const second = new oc.gp_Vec();
    try {
      // Stay inside the adjoining knot spans, including the closing seam.
      const knots = [0];
      for (let i = 2; i <= curve.NbKnots(); i++) {
        knots.push(curve.Knot(i));
      }
      const left = u === 0 ? knots.at(-2)! - 1 : [...knots].reverse().find(t => t < u - 1e-9) ?? 0;
      const right = knots.find(t => t > u + 1e-9) ?? 1;
      const step = Math.min(u - left, right - u) * 1e-4;

      const stateAt = (t: number) => {
        curve.D2(t, point, first, second);
        const speed = first.Magnitude();
        if (speed === 0) {
          return null;
        }
        const crossed = first.Crossed(second);
        const curvature = crossed.Magnitude() / (speed * speed * speed);
        crossed.delete();
        return { direction: [first.X() / speed, first.Y() / speed, first.Z() / speed], curvature };
      };
      const before = stateAt(u === 0 ? 1 - step : u - step);
      const after = stateAt(u + step);
      if (!before || !after) {
        return null;
      }

      const cosine = before.direction.reduce((sum, v, d) => sum + v * after.direction[d], 0);
      if (Math.acos(Math.min(1, Math.max(-1, cosine))) > SectionCorrespondence.CORNER_ANGLE) {
        return 'corner';
      }
      const largest = Math.max(before.curvature, after.curvature);
      const jump = largest > 1e-4 ? Math.abs(before.curvature - after.curvature) / largest : 0;
      return jump > SectionCorrespondence.CURVATURE_JUMP ? 'joint' : null;
    } finally {
      point.delete();
      first.delete();
      second.delete();
    }
  }
}
