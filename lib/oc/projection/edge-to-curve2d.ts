import type { BRepAdaptor_Curve, Geom_BSplineCurve, gp_Ax1, gp_Pnt, TopoDS_Edge } from "ocjs-fluidcad";
import { getOC } from "../init.js";
import { EdgeQuery } from "../edge-query.js";
import { Plane } from "../../math/plane.js";
import { Vector3d } from "../../math/vector3d.js";
import type { Curve2D, Vec2 } from "../../io/drawing/drawing.js";
import { BSplineCurve2D } from "../../io/drawing/bspline.js";
import { Conic } from "../../io/drawing/conic.js";

/** What one edge draws on a plane. */
export type ProjectedCurve = {
  /** Null when the edge projects to a point (a line along the view direction). */
  curve: Curve2D | null;
  /** The curve is a sampled polyline: the edge's own curve could not be carried over. */
  approximated: boolean;
};

/**
 * One edge in space → the curve it draws on a plane, in the plane's own 2D
 * frame, exact wherever the geometry allows.
 *
 * An orthographic projection is an affine map, and the curve kinds a B-rep
 * holds are closed under affine maps: a line stays a line; a circle or
 * ellipse becomes a circle, an ellipse or — seen edge-on — a segment
 * (`Conic.fromConjugateDiameters`); a NURBS keeps its degree, knots and
 * weights and only its poles move. So the drawing carries the model's own
 * curves, not a fit of them. A polyline appears only when the kernel cannot
 * hand the curve over as a NURBS, and the result says so.
 */
export class EdgeToCurve2D {
  /** `tolerance` is a length in the document's unit: below it a curve has no extent. */
  static convert(edge: TopoDS_Edge, plane: Plane, tolerance: number): ProjectedCurve {
    const oc = getOC();
    const type = oc.GeomAbs_CurveType;
    const adaptor = new oc.BRepAdaptor_Curve(edge);
    try {
      const first = adaptor.FirstParameter();
      const last = adaptor.LastParameter();
      const kind = adaptor.GetType();

      if (kind === type.GeomAbs_Line) {
        return exact(EdgeToCurve2D.segment(adaptor, plane, first, last, tolerance));
      }
      if (kind === type.GeomAbs_Circle) {
        const circle = adaptor.Circle();
        try {
          const radius = circle.Radius();
          return exact(EdgeToCurve2D.conic(plane, circle.Location(), circle.XAxis(), circle.YAxis(), radius, radius, first, last, tolerance));
        } finally {
          circle.delete();
        }
      }
      if (kind === type.GeomAbs_Ellipse) {
        const ellipse = adaptor.Ellipse();
        try {
          return exact(EdgeToCurve2D.conic(
            plane, ellipse.Location(), ellipse.XAxis(), ellipse.YAxis(),
            ellipse.MajorRadius(), ellipse.MinorRadius(), first, last, tolerance,
          ));
        } finally {
          ellipse.delete();
        }
      }

      if (kind === type.GeomAbs_BSplineCurve || kind === type.GeomAbs_BezierCurve) {
        // A spline standing for a line or a circular arc (loft sections,
        // fillet rims, STEP imports) draws as the line or arc it is.
        const recovered = EdgeToCurve2D.recovered(edge, adaptor, plane, first, last, tolerance);
        if (recovered) {
          return recovered;
        }
      }

      // Everything else goes over as a NURBS: splines as they are, parabolas,
      // hyperbolas and offset curves through the kernel's conversion.
      try {
        return exact(EdgeToCurve2D.nurbs(edge, plane, tolerance));
      } catch {
        return { curve: EdgeToCurve2D.sampled(adaptor, plane, first, last, tolerance), approximated: true };
      }
    } finally {
      adaptor.delete();
    }
  }

  /**
   * The last resort on its own: the edge as a polyline that stays within
   * {@link SAMPLE_CHORD_FACTOR} tolerances of its projection. What
   * {@link convert} falls back to when the kernel cannot hand a curve over.
   */
  static sample(edge: TopoDS_Edge, plane: Plane, tolerance: number): Curve2D | null {
    const adaptor = new (getOC().BRepAdaptor_Curve)(edge);
    try {
      return EdgeToCurve2D.sampled(adaptor, plane, adaptor.FirstParameter(), adaptor.LastParameter(), tolerance);
    } finally {
      adaptor.delete();
    }
  }

  /** A point of space in the plane's 2D frame. */
  private static toLocal(plane: Plane, x: number, y: number, z: number): Vec2 {
    const dx = x - plane.origin.x;
    const dy = y - plane.origin.y;
    const dz = z - plane.origin.z;
    // "+ 0" folds the −0 a mirrored view's negated axis makes of a zero coordinate.
    return {
      x: dx * plane.xDirection.x + dy * plane.xDirection.y + dz * plane.xDirection.z + 0,
      y: dx * plane.yDirection.x + dy * plane.yDirection.y + dz * plane.yDirection.z + 0,
    };
  }

  /** `gp_Pnt` → the plane's frame; the kernel point is freed. */
  private static pointToLocal(plane: Plane, point: gp_Pnt): Vec2 {
    const local = EdgeToCurve2D.toLocal(plane, point.X(), point.Y(), point.Z());
    point.delete();
    return local;
  }

  private static segment(adaptor: BRepAdaptor_Curve, plane: Plane, first: number, last: number, tolerance: number): Curve2D | null {
    const a = EdgeToCurve2D.pointToLocal(plane, adaptor.Value(first));
    const b = EdgeToCurve2D.pointToLocal(plane, adaptor.Value(last));
    return Math.hypot(b.x - a.x, b.y - a.y) > tolerance ? { kind: 'line', a, b } : null;
  }

  /**
   * A circle or ellipse `C + rx·cos t·X + ry·sin t·Y` over `[first, last]`.
   * The kernel handles (`location`, the two axes) are freed here.
   */
  private static conic(
    plane: Plane,
    location: gp_Pnt,
    xAxis: gp_Ax1,
    yAxis: gp_Ax1,
    rx: number,
    ry: number,
    first: number,
    last: number,
    tolerance: number,
  ): Curve2D | null {
    const xDir = xAxis.Direction();
    const yDir = yAxis.Direction();
    const x = new Vector3d(xDir.X(), xDir.Y(), xDir.Z());
    const y = new Vector3d(yDir.X(), yDir.Y(), yDir.Z());
    xDir.delete();
    yDir.delete();
    xAxis.delete();
    yAxis.delete();
    const center = EdgeToCurve2D.pointToLocal(plane, location);
    const u = { x: rx * x.dot(plane.xDirection), y: rx * x.dot(plane.yDirection) };
    const v = { x: ry * y.dot(plane.xDirection), y: ry * y.dot(plane.yDirection) };
    return Conic.fromConjugateDiameters(center, u, v, first, last, tolerance);
  }

  /**
   * The line or circle a spline edge stands for, projected; null when the
   * spline is a real freeform curve. The recovery itself is the edge
   * filters' (`EdgeQuery.getEdgeGeometryRaw`), so a drawing and `edge().arc()`
   * agree on what is an arc.
   */
  private static recovered(
    edge: TopoDS_Edge,
    adaptor: BRepAdaptor_Curve,
    plane: Plane,
    first: number,
    last: number,
    tolerance: number,
  ): ProjectedCurve | null {
    const geometry = EdgeQuery.getEdgeGeometryRaw(edge);
    if (geometry.kind === 'line') {
      return exact(EdgeToCurve2D.segment(adaptor, plane, first, last, tolerance));
    }
    if (geometry.kind !== 'circle') {
      return null;
    }
    const { center, radius } = geometry;
    let axis = geometry.axisDirection.normalize();
    const toVector = (t: number) => {
      const p = adaptor.Value(t);
      const v = new Vector3d(p.X(), p.Y(), p.Z());
      p.delete();
      return v;
    };
    const centerVector = new Vector3d(center.x, center.y, center.z);
    const start = toVector(first);
    const end = toVector(last);

    // The recovery fits the circle to within its own tolerance (a micron),
    // so the fitted circle misses the edge's end points by that much — a gap
    // to the next edge of the outline. The arc drawn is therefore the one of
    // the recovered radius that passes through the edge's own two ends: the
    // centre moves by less than the fit was ever good for, and the outline
    // stays closed.
    let arcCenter = centerVector;
    const chord = end.subtract(start);
    const half = chord.length() / 2;
    if (!geometry.closed && half > tolerance && half <= radius) {
      const middle = start.add(chord.multiply(0.5));
      let toCenter = axis.cross(chord).normalize();
      if (toCenter.dot(centerVector.subtract(middle)) < 0) {
        toCenter = toCenter.negate();
      }
      arcCenter = middle.add(toCenter.multiply(Math.sqrt(Math.max(0, radius * radius - half * half))));
      // The axis square to the chord, so both ends lie in the circle's plane.
      const squared = chord.cross(toCenter).normalize();
      axis = squared.dot(axis) < 0 ? squared.negate() : squared;
    }

    // Where on the circle the edge runs is read off its start, middle and
    // end: X goes through the start, and the axis is turned so the middle
    // comes before the end.
    const xDir = start.subtract(arcCenter).normalize();
    let yDir = axis.cross(xDir);
    const angle = (v: Vector3d) => {
      const a = Math.atan2(v.dot(yDir), v.dot(xDir));
      return a < 0 ? a + 2 * Math.PI : a;
    };
    const middleOnArc = toVector((first + last) / 2).subtract(arcCenter);
    if (!geometry.closed && angle(middleOnArc) > angle(end.subtract(arcCenter))) {
      axis = axis.negate();
      yDir = axis.cross(xDir);
    }
    const sweep = geometry.closed ? 2 * Math.PI : angle(end.subtract(arcCenter));
    const u = { x: radius * xDir.dot(plane.xDirection), y: radius * xDir.dot(plane.yDirection) };
    const v = { x: radius * yDir.dot(plane.xDirection), y: radius * yDir.dot(plane.yDirection) };
    const local = EdgeToCurve2D.toLocal(plane, arcCenter.x, arcCenter.y, arcCenter.z);
    return exact(Conic.fromConjugateDiameters(local, u, v, 0, sweep, tolerance));
  }

  /**
   * The edge's curve as a clamped NURBS with its poles projected. Throws
   * when the kernel cannot convert the curve; the caller falls back to
   * sampling.
   */
  private static nurbs(edge: TopoDS_Edge, plane: Plane, tolerance: number): Curve2D | null {
    const oc = getOC();
    // The curve comes with the edge's location applied, over the edge's own range.
    const curve = oc.BRep_Tool.Curve(edge, 0, 1);
    let trimmed: InstanceType<typeof oc.Geom_TrimmedCurve> | null = null;
    let spline: Geom_BSplineCurve | null = null;
    try {
      // Trimming first is what cuts the spline to the edge: an edge usually
      // covers only part of its curve, and poles read untrimmed would draw
      // all of it.
      trimmed = new oc.Geom_TrimmedCurve(curve.returnValue, curve.First, curve.Last, true, true);
      spline = oc.GeomConvert.CurveToBSplineCurve(trimmed);
      if (spline.IsPeriodic()) {
        // A periodic knot vector means different things to different DXF
        // readers; the clamped form of the same curve means one.
        spline.SetNotPeriodic();
      }
      const poles: Vec2[] = [];
      const weights: number[] = [];
      const rational = spline.IsRational();
      for (let i = 1; i <= spline.NbPoles(); i++) {
        poles.push(EdgeToCurve2D.pointToLocal(plane, spline.Pole(i)));
        if (rational) {
          weights.push(spline.Weight(i));
        }
      }
      const knots: number[] = [];
      const multiplicities: number[] = [];
      for (let i = 1; i <= spline.NbKnots(); i++) {
        knots.push(spline.Knot(i));
        multiplicities.push(spline.Multiplicity(i));
      }
      const result: Extract<Curve2D, { kind: 'bspline' }> = {
        kind: 'bspline',
        degree: spline.Degree(),
        knots: BSplineCurve2D.flattenKnots(knots, multiplicities),
        poles,
        ...(rational ? { weights } : {}),
      };
      const invalid = BSplineCurve2D.invalidReason(result);
      if (invalid) {
        throw new Error(`The kernel's B-spline is not clamped: ${invalid}`);
      }
      // A planar curve seen edge-on: every pole lands on one line.
      const extent = BSplineCurve2D.collinearExtent(result, tolerance);
      if (extent === 'point') {
        return null;
      }
      return extent ? { kind: 'line', a: extent.a, b: extent.b } : result;
    } finally {
      spline?.delete();
      trimmed?.delete();
      curve[Symbol.dispose]();
    }
  }

  /** How far a sampled polyline may stray from the curve, in multiples of the tolerance. */
  static readonly SAMPLE_CHORD_FACTOR = 100;
  private static readonly SAMPLE_MAX_DEPTH = 12;

  /** The curve as a polyline, refined until every chord is within reach of the curve. */
  private static sampled(adaptor: BRepAdaptor_Curve, plane: Plane, first: number, last: number, tolerance: number): Curve2D | null {
    const chord = tolerance * EdgeToCurve2D.SAMPLE_CHORD_FACTOR;
    const at = (t: number) => EdgeToCurve2D.pointToLocal(plane, adaptor.Value(t));
    const points: Vec2[] = [];
    const refine = (t0: number, p0: Vec2, t1: number, p1: Vec2, depth: number) => {
      const tm = (t0 + t1) / 2;
      const pm = at(tm);
      const off = Math.hypot(pm.x - (p0.x + p1.x) / 2, pm.y - (p0.y + p1.y) / 2);
      if (depth < EdgeToCurve2D.SAMPLE_MAX_DEPTH && off > chord) {
        refine(t0, p0, tm, pm, depth + 1);
        refine(tm, pm, t1, p1, depth + 1);
      } else {
        points.push(p1);
      }
    };
    // Eight spans to start from, so a curve whose midpoint happens to sit on
    // its chord (an S) is still looked at.
    const spans = 8;
    let previousT = first;
    let previous = at(first);
    points.push(previous);
    for (let i = 1; i <= spans; i++) {
      const t = first + ((last - first) * i) / spans;
      const p = at(t);
      refine(previousT, previous, t, p, 0);
      previousT = t;
      previous = p;
    }
    const a = points[0];
    const b = points[points.length - 1];
    const closed = points.length > 3 && Math.hypot(a.x - b.x, a.y - b.y) <= tolerance;
    return { kind: 'polyline', points: closed ? points.slice(0, -1) : points, closed };
  }
}

function exact(curve: Curve2D | null): ProjectedCurve {
  return { curve, approximated: false };
}
