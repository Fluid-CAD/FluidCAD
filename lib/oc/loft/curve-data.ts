import type { Geom_BSplineCurve } from "ocjs-fluidcad";
import { getOC } from "../init.js";
import { NCollections } from "../ncollection.js";
import type { BSplineCurveData } from "../../math/bspline-interpolation.js";

/**
 * Plain-JS mirror of a `Geom_BSplineCurve`. `weights` is null for polynomial
 * curves; when present it holds one weight per pole (rational curve).
 */
export interface RationalBSplineData extends BSplineCurveData {
  weights: number[] | null;
}

/**
 * Moves B-spline curves between OCC handles and plain data, so the knot/pole
 * bookkeeping of the loft pipeline (concatenation, unification, skinning) can
 * run on ordinary arrays instead of chains of native calls.
 */
export class CurveData {
  static read(curve: Geom_BSplineCurve): RationalBSplineData {
    const poles: number[][] = [];
    for (let i = 1; i <= curve.NbPoles(); i++) {
      const pole = curve.Pole(i);
      poles.push([pole.X(), pole.Y(), pole.Z()]);
      pole.delete();
    }

    const knots: number[] = [];
    const multiplicities: number[] = [];
    for (let i = 1; i <= curve.NbKnots(); i++) {
      knots.push(curve.Knot(i));
      multiplicities.push(curve.Multiplicity(i));
    }

    let weights: number[] | null = null;
    if (curve.IsRational()) {
      weights = [];
      for (let i = 1; i <= curve.NbPoles(); i++) {
        weights.push(curve.Weight(i));
      }
    }

    return { poles, weights, knots, multiplicities, degree: curve.Degree() };
  }

  static build(data: RationalBSplineData): Geom_BSplineCurve {
    const oc = getOC();
    const [poles, disposePoles] = NCollections.toArray1Pnt(data.poles);
    const [knots, disposeKnots] = NCollections.toArray1Double(data.knots);
    const [multiplicities, disposeMultiplicities] = NCollections.toArray1Int(data.multiplicities);

    try {
      if (data.weights) {
        const [weights, disposeWeights] = NCollections.toArray1Double(data.weights);
        try {
          return new oc.Geom_BSplineCurve(poles, weights, knots, multiplicities, data.degree, false, false);
        } finally {
          disposeWeights();
        }
      }
      return new oc.Geom_BSplineCurve(poles, knots, multiplicities, data.degree, false);
    } finally {
      disposePoles();
      disposeKnots();
      disposeMultiplicities();
    }
  }
}
