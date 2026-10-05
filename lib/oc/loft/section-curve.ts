import type { Geom_BSplineCurve, TopoDS_Edge, TopoDS_Wire } from "ocjs-fluidcad";
import { getOC } from "../init.js";
import { CurveData } from "./curve-data.js";
import { ConicArc, ConicArcs, ConicFrame } from "./conic-arc.js";
import { mmTol } from "../../units/tolerance.js";
import { Point } from "../../math/point.js";

export interface WireSection {
  curve: Geom_BSplineCurve;
  /**
   * Actual wire junctions, at the exact knots used during concatenation —
   * indexed like `SectionCurve.wireVertices`.
   */
  vertices: { point: Point; parameter: number }[];
  /** The circle or ellipse the whole closed wire traces, if it is one. */
  conic?: ConicFrame;
}

/** One stretch of the section curve: a single edge, or a run of edges along one conic. */
interface SectionPiece {
  curve: Geom_BSplineCurve;
  /** Per edge of the piece, in traversal order: its wire index and where on the piece (0..1) it starts. */
  edges: { index: number; start: number }[];
}

/**
 * Turns a profile wire into a single clamped B-spline curve, parameterized
 * over [0, 1] with spans proportional to edge arc length. Wire vertices
 * survive as interior knots of multiplicity `degree` (C0), so any planar
 * profile — a polygon, a slot, a circle — becomes exactly one curve. That
 * single-curve form is what makes profiles with different edge counts
 * loftable against each other: compatibility reduces to sharing one degree
 * and one knot vector instead of matching edges pairwise.
 *
 * Every knot of full multiplicity is a place the loft wall may have to be
 * split into faces, so none is made that the profile does not ask for: a
 * circle or ellipse is one span (`ConicArcs`), and consecutive edges along
 * one conic are that same span cut at their vertices — a cut that leaves
 * the curve as smooth as it was, and that the skin undoes wherever nothing
 * is pinned to the vertex.
 */
export class SectionCurve {
  // Rational→polynomial section conversion tolerance (mm). Loose enough to
  // keep pole counts small — pole count drives the cost of every downstream
  // stage (knot union, skinning, surface, meshing). Caps always sew exactly
  // (they share the section's poles), so this only bounds the deviation of
  // the loft wall from the true profile curve.
  private static get APPROX_TOLERANCE(): number {
    return mmTol(1e-4);
  }
  private static readonly LENGTH_SAMPLES = 32;
  /** Most segments one knot span of a rational curve is cut into when approximated. */
  private static readonly MAX_SPAN_PIECES = 4096;

  /**
   * With `forcePolynomial`, rational pieces (arcs, circles) are approximated
   * as polynomial B-splines before concatenation — piece-by-piece, so profile
   * corners stay sharp. Used when sections with different weight structures
   * must share one surface (see `SectionCompatibility`).
   */
  static fromWire(wire: TopoDS_Wire, forcePolynomial = false): Geom_BSplineCurve {
    return SectionCurve.fromWireWithVertices(wire, forcePolynomial).curve;
  }

  /**
   * The wire's junction vertices in traversal order — entry i is where
   * non-degenerated edge i starts, so it lines up with piece i of the section
   * curve. This walk is the one definition of "a vertex a connection can
   * use": a single closed edge (a full circle/ellipse) yields none, its lone
   * vertex being an artificial seam rather than a junction.
   */
  static wireVertices(wire: TopoDS_Wire): Point[] {
    const oc = getOC();
    const points: Point[] = [];
    const explorer = new oc.BRepTools_WireExplorer(wire);
    try {
      while (explorer.More()) {
        if (!oc.BRep_Tool.Degenerated(explorer.Current())) {
          const vertex = explorer.CurrentVertex();
          const point = oc.BRep_Tool.Pnt(vertex);
          points.push(new Point(point.X(), point.Y(), point.Z()));
          point.delete();
          vertex.delete();
        }
        explorer.Next();
      }
    } finally {
      explorer.delete();
    }
    if (wire.Closed() && points.length === 1) {
      return [];
    }
    return points;
  }

  static fromWireWithVertices(wire: TopoDS_Wire, forcePolynomial = false): WireSection {
    const oc = getOC();
    const edges: { arc: ConicArc | null; curve: Geom_BSplineCurve | null }[] = [];
    const pieces: SectionPiece[] = [];
    const explorer = new oc.BRepTools_WireExplorer(wire);
    try {
      while (explorer.More()) {
        const edge = explorer.Current();
        if (!oc.BRep_Tool.Degenerated(edge)) {
          const arc = ConicArcs.ofEdge(edge);
          edges.push({ arc, curve: arc ? null : SectionCurve.edgeToBSpline(edge) });
        }
        explorer.Next();
      }
      if (edges.length === 0) {
        throw new Error("Loft profile wire has no usable edges.");
      }

      const closed = wire.Closed();
      const conic = SectionCurve.collectPieces(edges, closed, pieces);
      if (forcePolynomial) {
        for (const piece of pieces) {
          if (piece.curve.IsRational()) {
            const polynomial = SectionCurve.toPolynomial(piece.curve, SectionCurve.APPROX_TOLERANCE);
            piece.curve.delete();
            piece.curve = polynomial;
          }
        }
      }

      const { curve, breaks } = SectionCurve.concatenateWithBreaks(pieces.map(piece => piece.curve), closed);
      const parameters = new Array<number>(edges.length);
      for (const [j, piece] of pieces.entries()) {
        for (const edge of piece.edges) {
          parameters[edge.index] = breaks[j] + edge.start * (breaks[j + 1] - breaks[j]);
        }
      }
      const vertices = SectionCurve.wireVertices(wire)
        .map((point, i) => ({ point, parameter: SectionCurve.junctionKnot(curve, parameters[i]) }));
      return { curve, vertices, conic: conic ?? undefined };
    } finally {
      explorer.delete();
      for (const edge of edges) {
        edge.curve?.delete();
      }
      for (const piece of pieces) {
        piece.curve.delete();
      }
    }
  }

  /**
   * Groups the wire's edges into pieces, appended to `pieces` in the order
   * the section curve runs through them. Edges that carry on along one conic
   * become one piece; a closed wire starts at the beginning of such a run
   * rather than in its middle, so no run is cut by the curve's own start.
   * Edge curves handed to a piece are owned by it from then on. Returns the
   * conic's frame when the whole closed wire is one conic.
   */
  private static collectPieces(
    edges: { arc: ConicArc | null; curve: Geom_BSplineCurve | null }[],
    closed: boolean,
    pieces: SectionPiece[],
  ): ConicFrame | null {
    const count = edges.length;
    const continues = (i: number) => {
      const previous = edges[(i - 1 + count) % count].arc;
      const arc = edges[i].arc;
      return previous !== null && arc !== null && ConicArcs.extend(previous, arc) !== null;
    };
    let first = 0;
    if (closed && count > 1) {
      const runStart = edges.findIndex((_, i) => !continues(i));
      first = Math.max(0, runStart);
    }

    let conic: ConicFrame | null = null;
    for (let offset = 0; offset < count;) {
      const index = (first + offset) % count;
      const edge = edges[index];
      if (!edge.arc) {
        pieces.push({ curve: edge.curve!, edges: [{ index, start: 0 }] });
        edge.curve = null;
        offset++;
        continue;
      }

      // Take every edge that carries on along the same conic, up to one turn.
      let arc = edge.arc;
      const members = [{ index, angle: arc.from }];
      while (offset + members.length < count) {
        const nextIndex = (first + offset + members.length) % count;
        const next = edges[nextIndex].arc;
        const extended = next ? ConicArcs.extend(arc, next) : null;
        if (!extended) {
          break;
        }
        members.push({ index: nextIndex, angle: arc.to });
        arc = extended;
      }

      const curve = CurveData.build(ConicArcs.toBSpline(arc));
      const starts = members.map((member, m) => m === 0 ? 0 : ConicArcs.parameterAt(arc, member.angle));
      for (const start of starts.slice(1)) {
        curve.InsertKnot(start, curve.Degree(), 0, true);
      }
      pieces.push({ curve, edges: members.map((member, m) => ({ index: member.index, start: starts[m] })) });
      if (closed && members.length === count && ConicArcs.isFullTurn(arc)) {
        conic = arc.frame;
      }
      offset += members.length;
    }
    return conic;
  }

  /** The knot of full multiplicity standing for a wire vertex computed to sit at `parameter`. */
  private static junctionKnot(curve: Geom_BSplineCurve, parameter: number): number {
    const degree = curve.Degree();
    let nearest = parameter;
    let gap = 1e-9;
    for (let i = 1; i <= curve.NbKnots(); i++) {
      const distance = Math.abs(curve.Knot(i) - parameter);
      if (curve.Multiplicity(i) >= degree && distance <= gap) {
        nearest = curve.Knot(i);
        gap = distance;
      }
    }
    // The closing knot is the curve's own start.
    return nearest === 1 ? 0 : nearest;
  }

  /**
   * Concatenates ordered, connected pieces into one clamped B-spline over
   * [0, 1]: junctions become interior knots of multiplicity `degree` and the
   * shared endpoint poles collapse into one. If any piece is rational, every
   * piece contributes weights. A NURBS is unchanged under a global weight
   * scale, and the only cross-piece constraint is agreement at the shared
   * junction pole — so each piece is chain-scaled to match its predecessor's
   * trailing weight (the first piece is anchored at weight 1).
   *
   * Pieces span parameter ranges proportional to their arc length, unless
   * `spans` prescribes the fractions explicitly (rail-contact alignment
   * re-proportions sections so matching features share parameters).
   */
  static concatenate(pieces: Geom_BSplineCurve[], closed: boolean, spans?: number[]): Geom_BSplineCurve {
    return SectionCurve.concatenateWithBreaks(pieces, closed, spans).curve;
  }

  private static concatenateWithBreaks(
    pieces: Geom_BSplineCurve[], closed: boolean, spans?: number[],
  ): { curve: Geom_BSplineCurve; breaks: number[] } {
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
    const lengths = spans ?? pieces.map(piece => SectionCurve.approximateLength(piece));
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

    return { curve: CurveData.build({ poles, weights, knots, multiplicities, degree }), breaks };
  }

  /**
   * Approximates any B-spline with a polynomial (non-rational) one within
   * `tolerance`, as a chain of cubic Hermite segments: each matches position
   * and tangent at its ends, so neighbours join C1. Every knot span of the
   * curve is halved until its segments fit — error falls sixteenfold per
   * halving — so the pole count follows the curvature of each span, never a
   * sample budget.
   *
   * A knot of full multiplicity in the source is a junction (a wire vertex,
   * possibly a corner) and stays one: its two sides are fitted with their
   * own tangents and joined C0. Everything else comes out C1.
   */
  static toPolynomial(curve: Geom_BSplineCurve, tolerance: number): Geom_BSplineCurve {
    const oc = getOC();
    const point = new oc.gp_Pnt();
    const vector = new oc.gp_Vec();
    const sample = (t: number, span: number) => {
      // One-sided: at a junction the two spans disagree on the tangent.
      curve.LocalD1(t, span, span + 1, point, vector);
      return {
        position: [point.X(), point.Y(), point.Z()],
        tangent: [vector.X(), vector.Y(), vector.Z()],
      };
    };

    try {
      const breakpoints: number[] = [curve.Knot(1)];
      const junctions: boolean[] = [true];
      const segments: number[][][] = [];
      for (let span = 1; span < curve.NbKnots(); span++) {
        const [from, to] = [curve.Knot(span), curve.Knot(span + 1)];
        let fitted: { ends: number[]; segments: number[][][] } | null = null;
        for (let pieces = 1; pieces <= SectionCurve.MAX_SPAN_PIECES && !fitted; pieces *= 2) {
          const ends: number[] = [];
          const candidate: number[][][] = [];
          let previous = sample(from, span);
          for (let m = 1; m <= pieces; m++) {
            const end = m === pieces ? to : from + ((to - from) * m) / pieces;
            const start = ends.length ? ends[ends.length - 1] : from;
            const next = sample(end, span);
            const h = (end - start) / 3;
            candidate.push([
              previous.position,
              previous.position.map((v, d) => v + previous.tangent[d] * h),
              next.position.map((v, d) => v - next.tangent[d] * h),
              next.position,
            ]);
            ends.push(end);
            previous = next;
          }
          if (SectionCurve.maxHermiteDeviation(curve, [from, ...ends], candidate) <= tolerance) {
            fitted = { ends, segments: candidate };
          }
        }
        if (!fitted) {
          throw new Error("Loft could not approximate a rational profile curve within tolerance.");
        }

        breakpoints.push(...fitted.ends);
        segments.push(...fitted.segments);
        junctions.push(...fitted.ends.map((_, m) =>
          m === fitted.ends.length - 1 && curve.Multiplicity(span + 1) >= curve.Degree()));
      }
      junctions[junctions.length - 1] = true;
      return SectionCurve.assembleCubicSegments(breakpoints, junctions, segments);
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

  /**
   * Joins cubic Hermite segments into one B-spline over the original
   * parameter range. Where neighbours share position and parametric tangent
   * the join is C1 and its knot needs multiplicity 2 only: the junction
   * point is implied by the inner poles on either side. A triple knot would
   * describe the same curve as formally C0, and the loft wall would have to
   * be split into a face per segment. Junctions keep the triple knot and
   * their own pole.
   */
  private static assembleCubicSegments(
    breakpoints: number[],
    junctions: boolean[],
    segments: number[][][],
  ): Geom_BSplineCurve {
    const degree = 3;
    const last = breakpoints.length - 1;
    const multiplicities = breakpoints.map((_, i) =>
      i === 0 || i === last ? degree + 1 : junctions[i] ? degree : degree - 1,
    );

    const poles: number[][] = [segments[0][0]];
    for (const [s, segment] of segments.entries()) {
      poles.push(segment[1], segment[2]);
      if (junctions[s + 1]) {
        poles.push(segment[3]);
      }
    }

    return CurveData.build({ poles, weights: null, knots: [...breakpoints], multiplicities, degree });
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
