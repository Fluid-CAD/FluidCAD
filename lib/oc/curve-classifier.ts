import type { BRepAdaptor_Curve, gp_Circ, gp_Elips, gp_Lin, GeomAdaptor_Curve, TopoDS_Edge, TopoDS_Shape } from "ocjs-fluidcad";
import { getOC } from "./init.js";
import { Point } from "../math/point.js";
import { Vector3d } from "../math/vector3d.js";
import { Shape } from "../common/shape.js";
import type { Edge } from "../common/edge.js";
import { mmTol } from "../units/tolerance.js";
import { lazily } from "../helpers/lazily.js";

/** What an edge's curve is, whatever the kernel stores it as. */
export type CurveKind = 'line' | 'circle' | 'arc' | 'ellipse' | 'spline' | 'other';

/** An edge's curve kind and the sizes that go with it; see {@link CurveClassifier.classify}. */
export type CurveClass = {
  readonly kind: CurveKind;
  /** True when the kind was recovered from a B-spline or Bezier curve. */
  readonly recovered: boolean;
  /** The edge returns to its start: a full circle, a full ellipse, a closed spline. */
  readonly closed: boolean;
  /**
   * The edge lies in one plane. A line, a circle, an arc and an ellipse do
   * by their kind — one recovered from a B-spline within
   * {@link CurveClassifier.tolerance} of it, like the kind itself. A spline
   * or any other curve is fitted on first read; see {@link plane}.
   */
  readonly planar: boolean;
  /** For a circle or an arc. */
  readonly radius?: number;
  /** For an ellipse. */
  readonly majorRadius?: number;
  readonly minorRadius?: number;
  /** For a circle, an arc or an ellipse: the centre. */
  readonly center?: Point;
  /** For a circle, an arc or an ellipse: the normal of its plane. */
  readonly axisDirection?: Vector3d;
  /** For a line: a point on it. */
  readonly origin?: Point;
  /** For a line: its unit direction. */
  readonly direction?: Vector3d;
  /**
   * For a planar spline or other curve: the plane fitted to it, as a point
   * of the curve and the plane's unit normal. Fitted on first read and
   * kept; see {@link CurveClassifier.planarityTolerance} for what "in a
   * plane" holds to.
   */
  readonly plane?: CurvePlane;
  /** The edge's length; integrated on first read, and kept, where the kind gives no formula. */
  readonly length: number;
};

/** A plane a curve lies in: a point and the unit normal. */
export type CurvePlane = { origin: Point; normal: Vector3d };

/**
 * One wrapper's class with the tolerance it was classified at
 * (unit-dependent), and what readers derived from it.
 */
type CachedClass = { tolerance: number; value: CurveClass; derived: Map<string, unknown> };

const classes = new WeakMap<Shape, CachedClass>();

type Writable<T> = { -readonly [K in keyof T]: T[K] };

/** The analytic part of a class: what a line, circle or ellipse reads off its curve. */
type Analytic = Writable<Omit<CurveClass, 'recovered' | 'closed' | 'planar' | 'plane' | 'length'>> & { length?: number };

/**
 * The one classifier for edges. Filters, properties, selection probes and
 * measure all read an edge's kind from here, so they cannot disagree.
 *
 * A native line, circle or ellipse reads straight off the curve. A B-spline
 * or Bezier edge — what lofts, sweeps and STEP imports carry even for
 * straight segments and circular arcs — is handed to OCC's analytical
 * converter, which recovers the line, circle or ellipse it approximates
 * within {@link CurveClassifier.tolerance}; one it cannot recover is a
 * `spline`. Any other curve (hyperbola, parabola, offset) is `other`.
 */
export class CurveClassifier {

  /** See {@link CurveClassifier.tolerance}. */
  private static readonly TOLERANCE_MM = 1e-3;

  /** See {@link CurveClassifier.planarityTolerance}. */
  private static readonly PLANARITY_TOLERANCE_MM = 1e-6;

  /** The edge's class, kept per wrapper for the tolerance it was classified at. */
  static classify(edge: Edge): CurveClass {
    return CurveClassifier.cached(edge).value;
  }

  /**
   * The class of a raw edge, asked of OCCT every time. Its length and plane
   * are read off the raw edge when first asked for, so read them while
   * that edge lives.
   */
  static classifyRaw(edge: TopoDS_Shape): CurveClass {
    return CurveClassifier.classifyWith(edge, () => edge);
  }

  /**
   * What a reader derives from the edge's class (a plane question, say),
   * computed once and kept beside the class: it is dropped when the class
   * is, so it never outlives the tolerance it was derived at.
   */
  static derived<T>(edge: Edge, key: string, compute: () => T): T {
    const { derived } = CurveClassifier.cached(edge);
    if (!derived.has(key)) {
      derived.set(key, compute());
    }
    return derived.get(key) as T;
  }

  private static cached(edge: Edge): CachedClass {
    const tolerance = CurveClassifier.tolerance();
    let cached = classes.get(edge);
    if (cached?.tolerance !== tolerance) {
      cached = {
        tolerance,
        value: CurveClassifier.classifyWith(edge.getShape(), () => edge.getShape()),
        derived: new Map(),
      };
      classes.set(edge, cached);
    }
    return cached;
  }

  /** Classifies `edge`; `source` hands the length integration and the plane fit the edge when they are first asked for. */
  private static classifyWith(edge: TopoDS_Shape, source: () => TopoDS_Shape): CurveClass {
    const oc = getOC();
    const ocEdge = oc.TopoDS.Edge(edge);
    try {
      const adaptor = new oc.BRepAdaptor_Curve(ocEdge);
      try {
        const closed = adaptor.IsClosed();
        const first = adaptor.FirstParameter();
        const last = adaptor.LastParameter();
        const type = adaptor.GetType();
        if (type === oc.GeomAbs_CurveType.GeomAbs_BSplineCurve || type === oc.GeomAbs_CurveType.GeomAbs_BezierCurve) {
          const recovered = CurveClassifier.recover(ocEdge, closed);
          if (recovered) {
            return CurveClassifier.complete(recovered, true, closed, source);
          }
          return CurveClassifier.complete({ kind: 'spline' }, false, closed, source, true);
        }
        const native = CurveClassifier.readAnalytic(adaptor, closed, first, last);
        if (native) {
          return CurveClassifier.complete(native, false, closed, source);
        }
        return CurveClassifier.complete({ kind: 'other' }, false, closed, source, true);
      } finally {
        adaptor.delete();
      }
    } finally {
      ocEdge.delete();
    }
  }

  /**
   * How far a B-spline may stray from the line, circle or ellipse it stands
   * for, and how closely a measured length or radius must match a requested
   * one. A loft approximates its section arcs to a few 1e-5 mm, so 1e-3 mm
   * keeps them recognisable while staying far below any feature size.
   */
  static tolerance(): number {
    return mmTol(CurveClassifier.TOLERANCE_MM);
  }

  /**
   * How far a spline or other curve may lie off the plane fitted to it and
   * still be planar: 1e-6 mm, but never below OCCT's own 1e-7 floor read in
   * the document's unit, as no edge carries a tighter tolerance for the fit
   * to apply. This is the figure the fit holds the curve to whatever
   * tolerance the edge itself carries (see `fitPlane`). A curve recovered
   * as an arc or an ellipse is planar by its kind instead: within
   * {@link tolerance} of the recovered curve's plane, like the kind itself.
   */
  static planarityTolerance(): number {
    return Math.max(mmTol(CurveClassifier.PLANARITY_TOLERANCE_MM), getOC().Precision.Confusion());
  }

  /**
   * Fills in what every class carries: closure, planarity and length. A
   * line, a circle and an ellipse lie in a plane by their kind; a spline or
   * any other curve (`fit`) is asked of OCC's plane finder when its
   * planarity or plane is first read. A length the kind gives no formula
   * for is integrated when first read. Both are kept.
   */
  private static complete(
    analytic: Analytic,
    recovered: boolean,
    closed: boolean,
    source: () => TopoDS_Shape,
    fit = false,
  ): CurveClass {
    const { length, ...rest } = analytic;
    const value = { ...rest, recovered, closed } as Writable<CurveClass>;
    if (length !== undefined) {
      value.length = length;
    } else {
      lazily(value, 'length', () => CurveClassifier.measureLength(source()));
    }
    if (!fit) {
      value.planar = true;
      return value;
    }
    // The tolerance is the one in force now: the class is kept for it.
    const tolerance = CurveClassifier.planarityTolerance();
    lazily(value, 'plane', () => CurveClassifier.fitPlane(source(), tolerance) ?? undefined);
    lazily(value, 'planar', () => value.plane !== undefined);
    return value;
  }

  /**
   * The plane a curve lies in within `tolerance`, or null when it lies in
   * none. `BRepBuilderAPI_FindPlane` fits the edge's curve over the edge's
   * own range (so a flat piece of a curve that leaves the plane elsewhere
   * is planar) and accepts the plane when the curve stays within the
   * larger of the given tolerance and the edge's own. An imported edge
   * often carries a loose tolerance, which would pass a curve that leaves
   * its plane by that much and tilt the fitted normal, so such an edge is
   * fitted through a clean copy: the same curve over the same range, at
   * `tolerance`. The origin is the curve's start point dropped onto the
   * plane, so no point of the curve is farther from it than the curve is
   * long.
   */
  private static fitPlane(edge: TopoDS_Shape, tolerance: number): CurvePlane | null {
    const oc = getOC();
    const owned: { delete(): void }[] = [];
    try {
      const typed = oc.TopoDS.Edge(edge);
      owned.push(typed);
      const fitted = oc.BRep_Tool.Tolerance(typed) > tolerance ? CurveClassifier.cleanCopy(typed, tolerance) : null;
      if (fitted) {
        owned.push(fitted);
      }
      const finder = new oc.BRepBuilderAPI_FindPlane(fitted ?? typed, tolerance);
      owned.push(finder);
      if (!finder.Found()) {
        return null;
      }
      const plane = finder.Plane();
      owned.push(plane);
      const pln = plane.Pln();
      owned.push(pln);
      const location = pln.Location();
      const axis = pln.Axis();
      const direction = axis.Direction();
      owned.push(location, axis, direction);
      const normal = new Vector3d(direction.X(), direction.Y(), direction.Z()).normalize();
      const adaptor = new oc.BRepAdaptor_Curve(typed);
      owned.push(adaptor);
      const start = adaptor.Value(adaptor.FirstParameter());
      owned.push(start);
      const lift = (start.X() - location.X()) * normal.x + (start.Y() - location.Y()) * normal.y + (start.Z() - location.Z()) * normal.z;
      return {
        origin: new Point(start.X() - lift * normal.x, start.Y() - lift * normal.y, start.Z() - lift * normal.z),
        normal,
      };
    } finally {
      for (const object of owned.reverse()) {
        object.delete();
      }
    }
  }

  /**
   * An edge on `edge`'s 3D curve over the same range, carrying `tolerance`
   * and nothing else; null when the edge has no 3D curve to copy (it lies
   * on a surface only).
   */
  private static cleanCopy(edge: TopoDS_Edge, tolerance: number): TopoDS_Edge | null {
    const oc = getOC();
    const curve = oc.BRep_Tool.Curve(edge, 0, 1);
    const builder = new oc.BRep_Builder();
    try {
      if (!curve.returnValue) {
        return null;
      }
      const copy = new oc.TopoDS_Edge();
      builder.MakeEdge(copy, curve.returnValue, tolerance);
      builder.Range(copy, curve.First, curve.Last, true);
      return copy;
    } finally {
      builder.delete();
      curve[Symbol.dispose]();
    }
  }

  /**
   * The plane a planar curve lies in: a circle's, an arc's or an ellipse's
   * own (centre and axis), or the one fitted to a spline or other curve.
   * Null for a line, which lies in many, and for a curve in none.
   */
  static planeOf(curve: CurveClass): CurvePlane | null {
    if (curve.plane) {
      return curve.plane;
    }
    if ((curve.kind === 'circle' || curve.kind === 'arc' || curve.kind === 'ellipse') && curve.center && curve.axisDirection) {
      return { origin: curve.center, normal: curve.axisDirection.normalize() };
    }
    return null;
  }

  /** A native line, circle or ellipse read off its adaptor; null for any other curve. */
  private static readAnalytic(
    adaptor: BRepAdaptor_Curve | GeomAdaptor_Curve,
    closed: boolean,
    first: number,
    last: number,
  ): Analytic | null {
    const oc = getOC();
    const type = adaptor.GetType();
    if (type === oc.GeomAbs_CurveType.GeomAbs_Line) {
      const line = adaptor.Line();
      const analytic = CurveClassifier.lineOf(line);
      line.delete();
      return { ...analytic, length: Math.abs(last - first) };
    }
    if (type === oc.GeomAbs_CurveType.GeomAbs_Circle) {
      const circle = adaptor.Circle();
      const analytic = CurveClassifier.circleOf(circle, closed);
      circle.delete();
      return { ...analytic, length: (analytic.radius ?? 0) * Math.abs(last - first) };
    }
    if (type === oc.GeomAbs_CurveType.GeomAbs_Ellipse) {
      const ellipse = adaptor.Ellipse();
      const analytic = CurveClassifier.ellipseOf(ellipse);
      ellipse.delete();
      return analytic;
    }
    return null;
  }

  /**
   * The line, circle or ellipse a B-spline or Bezier edge traces within
   * {@link tolerance}, the simplest first; null when it traces none.
   */
  private static recover(edge: TopoDS_Edge, closed: boolean): Analytic | null {
    const oc = getOC();
    const curve = oc.BRep_Tool.Curve(edge, 0, 1);
    if (!curve.returnValue) {
      curve[Symbol.dispose]();
      return null;
    }
    const converter = new oc.GeomConvert_CurveToAnaCurve(curve.returnValue);
    converter.SetConvType(oc.GeomConvert_ConvType.GeomConvert_Simplest);
    const converted = converter.ConvertToAnalytical(CurveClassifier.tolerance(), curve.First, curve.Last);
    try {
      if (!converted.returnValue || !converted.theResultCurve) {
        return null;
      }
      const analytical = new oc.GeomAdaptor_Curve(converted.theResultCurve);
      try {
        return CurveClassifier.readAnalytic(analytical, closed, converted.newF, converted.newL);
      } finally {
        analytical.delete();
      }
    } finally {
      converted[Symbol.dispose]();
      converter.delete();
      curve[Symbol.dispose]();
    }
  }

  private static lineOf(line: gp_Lin): Analytic {
    const location = line.Location();
    const dir = line.Direction();
    const analytic: Analytic = {
      kind: 'line',
      origin: new Point(location.X(), location.Y(), location.Z()),
      direction: new Vector3d(dir.X(), dir.Y(), dir.Z()),
    };
    dir.delete();
    location.delete();
    return analytic;
  }

  private static circleOf(circle: gp_Circ, closed: boolean): Analytic {
    const location = circle.Location();
    const axis = circle.Axis();
    const dir = axis.Direction();
    const analytic: Analytic = {
      kind: closed ? 'circle' : 'arc',
      radius: circle.Radius(),
      center: new Point(location.X(), location.Y(), location.Z()),
      axisDirection: new Vector3d(dir.X(), dir.Y(), dir.Z()),
    };
    dir.delete();
    axis.delete();
    location.delete();
    return analytic;
  }

  private static ellipseOf(ellipse: gp_Elips): Analytic {
    const location = ellipse.Location();
    const axis = ellipse.Axis();
    const dir = axis.Direction();
    const analytic: Analytic = {
      kind: 'ellipse',
      majorRadius: ellipse.MajorRadius(),
      minorRadius: ellipse.MinorRadius(),
      center: new Point(location.X(), location.Y(), location.Z()),
      axisDirection: new Vector3d(dir.X(), dir.Y(), dir.Z()),
    };
    dir.delete();
    axis.delete();
    location.delete();
    return analytic;
  }

  private static measureLength(edge: TopoDS_Shape): number {
    const oc = getOC();
    const props = new oc.GProp_GProps();
    try {
      oc.BRepGProp.LinearProperties(edge, props, false, false);
      return props.Mass();
    } finally {
      props.delete();
    }
  }
}
