import type { Geom_BSplineCurve, TopoDS_Edge, TopoDS_Wire } from "ocjs-fluidcad";
import { getOC } from "../init.js";
import { CurveData } from "./curve-data.js";

/**
 * Turns a profile wire into a single clamped B-spline curve, parameterized
 * over [0, 1] with spans proportional to edge arc length. Corners survive as
 * interior knots of multiplicity `degree` (C0), so any planar profile — a
 * polygon, a slot, a circle — becomes exactly one curve. That single-curve
 * form is what makes profiles with different edge counts loftable against
 * each other: compatibility reduces to sharing one degree and one knot
 * vector instead of matching edges pairwise.
 */
export class SectionCurve {
  // Rational→polynomial section conversion tolerance (mm). Loose enough to
  // keep pole counts small — pole count drives the cost of every downstream
  // stage (knot union, skinning, surface, meshing). Caps always sew exactly
  // (they share the section's poles), so this only bounds the deviation of
  // the loft wall from the true profile curve.
  private static readonly APPROX_TOLERANCE = 1e-4;
  private static readonly LENGTH_SAMPLES = 32;

  /**
   * With `forcePolynomial`, rational pieces (arcs, circles) are approximated
   * as polynomial B-splines before concatenation — piece-by-piece, so profile
   * corners stay sharp. Used when sections with different weight structures
   * must share one surface (see `SectionCompatibility`).
   */
  static fromWire(wire: TopoDS_Wire, forcePolynomial = false): Geom_BSplineCurve {
    const oc = getOC();
    const pieces: Geom_BSplineCurve[] = [];

    const explorer = new oc.BRepTools_WireExplorer(wire);
    while (explorer.More()) {
      const edge = explorer.Current();
      if (!oc.BRep_Tool.Degenerated(edge)) {
        let piece = SectionCurve.edgeToBSpline(edge);
        if (forcePolynomial && piece.IsRational()) {
          const polynomial = SectionCurve.toPolynomial(piece, SectionCurve.APPROX_TOLERANCE);
          piece.delete();
          piece = polynomial;
        }
        pieces.push(piece);
      }
      explorer.Next();
    }
    explorer.delete();

    if (pieces.length === 0) {
      throw new Error("Loft profile wire has no usable edges.");
    }

    const section = SectionCurve.concatenate(pieces, wire.Closed());
    for (const piece of pieces) {
      piece.delete();
    }
    return section;
  }

  /**
   * Concatenates ordered, connected pieces into one clamped B-spline over
   * [0, 1]: junctions become interior knots of multiplicity `degree` and the
   * shared endpoint poles collapse into one. If any piece is rational, every
   * piece contributes weights. A NURBS is unchanged under a global weight
   * scale, and the only cross-piece constraint is agreement at the shared
   * junction pole — so each piece is chain-scaled to match its predecessor's
   * trailing weight (the first piece is anchored at weight 1).
   */
  static concatenate(pieces: Geom_BSplineCurve[], closed: boolean): Geom_BSplineCurve {
    const degree = Math.max(...pieces.map(piece => piece.Degree()));
    for (const piece of pieces) {
      if (piece.Degree() < degree) {
        piece.IncreaseDegree(degree);
      }
    }

    const datas = pieces.map(piece => CurveData.read(piece));
    const rational = datas.some(data => data.weights !== null);
    if (rational) {
      let junctionWeight = 1;
      for (const data of datas) {
        const pieceWeights = data.weights ?? new Array<number>(data.poles.length).fill(1);
        const factor = junctionWeight / pieceWeights[0];
        data.weights = pieceWeights.map(w => w * factor);
        junctionWeight = data.weights[data.weights.length - 1];
      }
    }

    // Piece spans proportional to arc length, over a total range of [0, 1].
    const lengths = pieces.map(piece => SectionCurve.approximateLength(piece));
    const totalLength = lengths.reduce((sum, length) => sum + length, 0);
    if (totalLength <= 0) {
      throw new Error("Loft profile wire is degenerate (zero total length).");
    }
    const breaks: number[] = [0];
    for (let i = 0; i < lengths.length; i++) {
      breaks.push(breaks[i] + lengths[i] / totalLength);
    }
    breaks[breaks.length - 1] = 1;

    const knots: number[] = [0];
    const multiplicities: number[] = [degree + 1];
    const poles: number[][] = [];
    const weights: number[] | null = rational ? [] : null;

    for (let i = 0; i < datas.length; i++) {
      const data = datas[i];
      const [start, end] = [breaks[i], breaks[i + 1]];
      const [a, b] = [data.knots[0], data.knots[data.knots.length - 1]];

      for (let k = 1; k < data.knots.length - 1; k++) {
        knots.push(start + ((data.knots[k] - a) / (b - a)) * (end - start));
        multiplicities.push(Math.min(data.multiplicities[k], degree));
      }
      if (i < datas.length - 1) {
        knots.push(end);
        multiplicities.push(degree);
      } else {
        knots.push(1);
        multiplicities.push(degree + 1);
      }

      // The junction pole is shared: seat it at the midpoint of the two
      // coincident clamped end poles so wire-tolerance gaps split evenly.
      const firstPoleIndex = i === 0 ? 0 : 1;
      if (i > 0) {
        const previous = poles[poles.length - 1];
        const incoming = data.poles[0];
        poles[poles.length - 1] = previous.map((v, d) => (v + incoming[d]) / 2);
      }
      for (let j = firstPoleIndex; j < data.poles.length; j++) {
        poles.push(data.poles[j]);
        if (weights) {
          weights.push(data.weights ? data.weights[j] : 1);
        }
      }
    }

    if (closed && poles.length > 1) {
      poles[poles.length - 1] = [...poles[0]];
    }

    return CurveData.build({ poles, weights, knots, multiplicities, degree });
  }

  /**
   * Approximates any B-spline with a polynomial (non-rational) one within
   * `tolerance`, as a chain of cubic Hermite segments (position + tangent
   * matched at the ends of every segment, so the result stays G1). Segments
   * split at the curve's own knots — rational conversions are typically only
   * C1 there, and keeping the reduced-continuity points on segment
   * boundaries preserves O(h⁴) convergence — then subdivide until every
   * segment fits. Pole count stays proportional to the geometry's curvature
   * (a circle needs a few dozen poles), never to a sample budget.
   */
  static toPolynomial(curve: Geom_BSplineCurve, tolerance: number): Geom_BSplineCurve {
    const oc = getOC();
    const point = new oc.gp_Pnt();
    const vector = new oc.gp_Vec();

    const spans: [number, number][] = [];
    for (let i = 1; i < curve.NbKnots(); i++) {
      spans.push([curve.Knot(i), curve.Knot(i + 1)]);
    }

    try {
      for (let subdivisions = 1; subdivisions <= 64; subdivisions *= 2) {
        const breakpoints: number[] = [spans[0][0]];
        for (const [a, b] of spans) {
          for (let m = 1; m <= subdivisions; m++) {
            breakpoints.push(a + ((b - a) * m) / subdivisions);
          }
        }

        const samples = breakpoints.map(t => {
          curve.D1(t, point, vector);
          return {
            position: [point.X(), point.Y(), point.Z()],
            tangent: [vector.X(), vector.Y(), vector.Z()],
          };
        });

        // One cubic Bézier per segment in Hermite form.
        const segments: number[][][] = [];
        for (let s = 0; s + 1 < breakpoints.length; s++) {
          const h = (breakpoints[s + 1] - breakpoints[s]) / 3;
          const from = samples[s];
          const to = samples[s + 1];
          segments.push([
            from.position,
            from.position.map((v, d) => v + from.tangent[d] * h),
            to.position.map((v, d) => v - to.tangent[d] * h),
            to.position,
          ]);
        }

        if (SectionCurve.maxHermiteDeviation(curve, breakpoints, segments) <= tolerance) {
          return SectionCurve.assembleCubicSegments(breakpoints, segments);
        }
      }
      throw new Error("Loft could not approximate a rational profile curve within tolerance.");
    } finally {
      point.delete();
      vector.delete();
    }
  }

  /** Largest distance between the Hermite segments and the curve, sampled inside each segment. */
  private static maxHermiteDeviation(
    curve: Geom_BSplineCurve,
    breakpoints: number[],
    segments: number[][][],
  ): number {
    const oc = getOC();
    const point = new oc.gp_Pnt();
    let maxDeviation = 0;

    for (let s = 0; s < segments.length; s++) {
      const [p0, p1, p2, p3] = segments[s];
      for (const local of [0.25, 0.5, 0.75]) {
        const t = breakpoints[s] + (breakpoints[s + 1] - breakpoints[s]) * local;
        curve.D0(t, point);

        const u = 1 - local;
        const b0 = u * u * u;
        const b1 = 3 * u * u * local;
        const b2 = 3 * u * local * local;
        const b3 = local * local * local;
        const dx = b0 * p0[0] + b1 * p1[0] + b2 * p2[0] + b3 * p3[0] - point.X();
        const dy = b0 * p0[1] + b1 * p1[1] + b2 * p2[1] + b3 * p3[1] - point.Y();
        const dz = b0 * p0[2] + b1 * p1[2] + b2 * p2[2] + b3 * p3[2] - point.Z();
        maxDeviation = Math.max(maxDeviation, Math.hypot(dx, dy, dz));
      }
    }

    point.delete();
    return maxDeviation;
  }

  /** Joins cubic Bézier segments into one B-spline over the original parameter range. */
  private static assembleCubicSegments(breakpoints: number[], segments: number[][][]): Geom_BSplineCurve {
    const degree = 3;
    const knots = [...breakpoints];
    const multiplicities = breakpoints.map((_, i) =>
      i === 0 || i === breakpoints.length - 1 ? degree + 1 : degree,
    );

    const poles: number[][] = [segments[0][0]];
    for (const segment of segments) {
      poles.push(segment[1], segment[2], segment[3]);
    }

    return CurveData.build({ poles, weights: null, knots, multiplicities, degree });
  }

  /** Curve arc length approximated by chord sampling — used only to proportion knot spans. */
  private static approximateLength(curve: Geom_BSplineCurve): number {
    const oc = getOC();
    const first = curve.FirstParameter();
    const last = curve.LastParameter();
    const point = new oc.gp_Pnt();

    let length = 0;
    let px = 0;
    let py = 0;
    let pz = 0;
    for (let i = 0; i <= SectionCurve.LENGTH_SAMPLES; i++) {
      const t = first + ((last - first) * i) / SectionCurve.LENGTH_SAMPLES;
      curve.D0(t, point);
      if (i > 0) {
        length += Math.hypot(point.X() - px, point.Y() - py, point.Z() - pz);
      }
      px = point.X();
      py = point.Y();
      pz = point.Z();
    }
    point.delete();
    return length;
  }

  private static edgeToBSpline(edge: TopoDS_Edge): Geom_BSplineCurve {
    const oc = getOC();
    const curveInfo = oc.BRep_Tool.Curve(edge, 0, 1);
    const trimmed = new oc.Geom_TrimmedCurve(curveInfo.returnValue, curveInfo.First, curveInfo.Last, true, true);
    const bspline = oc.GeomConvert.CurveToBSplineCurve(trimmed);
    trimmed.delete();

    if (bspline.IsPeriodic()) {
      bspline.SetNotPeriodic();
    }
    if (edge.Orientation() === oc.TopAbs_Orientation.TopAbs_REVERSED) {
      bspline.Reverse();
    }
    return bspline;
  }
}
