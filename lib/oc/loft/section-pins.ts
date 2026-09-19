import type { Geom_BSplineCurve } from "ocjs-fluidcad";
import { getOC } from "../init.js";
import { SectionCurve, WireSection } from "./section-curve.js";

/**
 * Validated connection vertices, one row per section and one column per
 * connection — each an index into `SectionCurve.wireVertices` of its wire.
 */
export class SectionPins {
  /** Pin parameters further than this from a junction knot are a pipeline bug. */
  private static readonly JUNCTION_TOLERANCE = 1e-9;

  constructor(private readonly vertexIndices: number[][]) {}

  /** Re-read exact junction knots on each pass, including polynomial retry. */
  parameters(sections: WireSection[]): number[][] {
    return sections.map((section, k) => this.vertexIndices[k].map(index => {
      const vertex = section.vertices[index];
      if (!vertex) {
        throw new Error("Loft internal error: connection vertex missing from section topology.");
      }
      return vertex.parameter;
    }));
  }

  /**
   * Replaces each pin parameter by the junction knot it names. Reversal and
   * seam shifts carry pins by arithmetic (`1 - u`, `u - seam`), which can
   * drift an ulp from the knot the curve actually holds; splitting at the
   * knot itself keeps every junction exact instead of leaning on the
   * kernel's split tolerance.
   */
  static snapToJunctions(curve: Geom_BSplineCurve, parameters: number[]): number[] {
    const degree = curve.Degree();
    const junctions: number[] = [];
    for (let i = 1; i <= curve.NbKnots(); i++) {
      if (curve.Multiplicity(i) >= degree) {
        junctions.push(curve.Knot(i));
      }
    }
    return parameters.map(u => {
      let nearest = u;
      let gap = Infinity;
      for (const knot of junctions) {
        if (Math.abs(knot - u) < gap) {
          gap = Math.abs(knot - u);
          nearest = knot;
        }
      }
      if (gap > SectionPins.JUNCTION_TOLERANCE) {
        throw new Error("Loft internal error: connection pin is not on a section junction.");
      }
      // The closing knot is the seam itself.
      return nearest === 1 ? 0 : nearest;
    });
  }

  /**
   * Parameters have already been oriented and shifted so connection 1 is
   * the seam. Validate cyclic order before aligning the remaining pins.
   * Input order is arbitrary; only the geometric order must agree.
   */
  static align(curves: Geom_BSplineCurve[], parameters: number[][]): number[] {
    const order = parameters[0].map((_, i) => i).slice(1)
      .sort((a, b) => parameters[0][a] - parameters[0][b]);
    for (let k = 1; k < parameters.length; k++) {
      for (let i = 0; i < order.length; i++) {
        for (let j = i + 1; j < order.length; j++) {
          const a = order[i];
          const b = order[j];
          if ((parameters[k - 1][b] - parameters[k - 1][a])
            * (parameters[k][b] - parameters[k][a]) <= 0) {
            throw new Error(
              `Loft connections ${Math.min(a, b) + 1} and ${Math.max(a, b) + 1} cross between profile ${k} and profile ${k + 1}.`,
            );
          }
        }
      }
    }

    const splits = parameters.map(params => order.map(i => params[i]));
    const targets = order.map(i => parameters.reduce((sum, params) => sum + params[i], 0) / parameters.length);
    for (let k = 0; k < curves.length; k++) {
      if (splits[k].every((u, i) => u === targets[i])) {
        continue;
      }
      const aligned = SectionPins.reproportion(curves[k], splits[k], targets);
      curves[k].delete();
      curves[k] = aligned;
    }
    return targets;
  }

  /** Preserves the input; callers own the returned curve and the original. */
  static reproportion(curve: Geom_BSplineCurve, splits: number[], targets: number[]): Geom_BSplineCurve {
    const oc = getOC();
    const bounds = [0, ...splits, 1];
    const targetBounds = [0, ...targets, 1];
    const pieces: Geom_BSplineCurve[] = [];
    try {
      for (let i = 0; i + 1 < bounds.length; i++) {
        // unit: dimensionless parameters on [0, 1].
        pieces.push(oc.GeomConvert.SplitBSplineCurve(curve, bounds[i], bounds[i + 1], 1e-9, true));
      }
      const spans = targetBounds.slice(1).map((t, i) => t - targetBounds[i]);
      return SectionCurve.concatenate(pieces, true, spans);
    } finally {
      for (const piece of pieces) {
        piece.delete();
      }
    }
  }
}
