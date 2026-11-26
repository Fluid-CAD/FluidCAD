import type { BRepAdaptor_Curve, gp_Circ, gp_Elips, gp_Lin, GeomAdaptor_Curve, TopoDS_Edge, TopoDS_Shape } from "ocjs-fluidcad";
import { getOC } from "./init.js";
import { Point } from "../math/point.js";
import { Vector3d } from "../math/vector3d.js";
import { Shape } from "../common/shape.js";
import type { Edge } from "../common/edge.js";
import { mmTol } from "../units/tolerance.js";

/** What an edge's curve is, whatever the kernel stores it as. */
export type CurveKind = 'line' | 'circle' | 'arc' | 'ellipse' | 'spline' | 'other';

/** An edge's curve kind and the sizes that go with it; see {@link CurveClassifier.classify}. */
export type CurveClass = {
  kind: CurveKind;
  /** True when the kind was recovered from a B-spline or Bezier curve. */
  recovered: boolean;
  /** The edge returns to its start: a full circle, a full ellipse, a closed spline. */
  closed: boolean;
  /** The edge lies in one plane. */
  planar: boolean;
  /** For a circle or an arc. */
  radius?: number;
  /** For an ellipse. */
  majorRadius?: number;
  minorRadius?: number;
  /** For a circle, an arc or an ellipse: the centre. */
  center?: Point;
  /** For a circle, an arc or an ellipse: the normal of its plane. */
  axisDirection?: Vector3d;
  /** For a line: a point on it. */
  origin?: Point;
  /** For a line: its unit direction. */
  direction?: Vector3d;
  /** For a planar spline or other curve: a point of its plane and the plane's unit normal. */
  plane?: { origin: Point; normal: Vector3d };
  length: number;
};

/** The class of one wrapper, with the tolerance it was classified at (unit-dependent). */
type CachedClass = { tolerance: number; value: CurveClass };

const classes = new WeakMap<Shape, CachedClass>();

/** The analytic part of a class: what a line, circle or ellipse reads off its curve. */
type Analytic = Omit<CurveClass, 'recovered' | 'closed' | 'planar' | 'plane' | 'length'> & { length?: number };

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

  /** How far a planar curve may lie off its plane. */
  private static readonly PLANARITY_TOLERANCE_MM = 1e-6;

  /** The edge's class, kept per wrapper for the tolerance it was classified at. */
  static classify(edge: Edge): CurveClass {
    const tolerance = CurveClassifier.tolerance();
    const cached = classes.get(edge);
    if (cached?.tolerance === tolerance) {
      return cached.value;
    }
    const value = CurveClassifier.classifyRaw(edge.getShape());
    classes.set(edge, { tolerance, value });
    return value;
  }

  /** The class of a raw edge, asked of OCCT every time. */
  static classifyRaw(edge: TopoDS_Shape): CurveClass {
    const oc = getOC();
    const ocEdge = oc.TopoDS.Edge(edge);
    const adaptor = new oc.BRepAdaptor_Curve(ocEdge);
    try {
      const closed = adaptor.IsClosed();
      const first = adaptor.FirstParameter();
      const last = adaptor.LastParameter();
      const type = adaptor.GetType();
      if (type === oc.GeomAbs_CurveType.GeomAbs_BSplineCurve || type === oc.GeomAbs_CurveType.GeomAbs_BezierCurve) {
        const recovered = CurveClassifier.recover(ocEdge, closed);
        if (recovered) {
          return CurveClassifier.complete(recovered, true, closed, ocEdge);
        }
        return CurveClassifier.complete({ kind: 'spline' }, false, closed, ocEdge, true);
      }
      const native = CurveClassifier.readAnalytic(adaptor, closed, first, last);
      if (native) {
        return CurveClassifier.complete(native, false, closed, ocEdge);
      }
      return CurveClassifier.complete({ kind: 'other' }, false, closed, ocEdge, true);
    } finally {
      adaptor.delete();
      // The adaptor held its own reference; the typed copy goes with it.
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
   * Fills in what every class carries: closure, planarity and length. A
   * line, a circle and an ellipse lie in a plane by their kind; a spline or
   * any other curve is asked of OCC's plane finder (`fitPlane`).
   */
  private static complete(
    analytic: Analytic,
    recovered: boolean,
    closed: boolean,
    edge: TopoDS_Edge,
    fit = false,
  ): CurveClass {
    const { length, ...rest } = analytic;
    const plane = fit ? CurveClassifier.fitPlane(edge) : null;
    return {
      ...rest,
      recovered,
      closed,
      planar: fit ? plane !== null : true,
      ...(plane ? { plane } : {}),
      length: length ?? CurveClassifier.measureLength(edge),
    };
  }

  /**
   * The plane a curve lies in, within {@link PLANARITY_TOLERANCE_MM}, or
   * null when it lies in none. `BRepBuilderAPI_FindPlane` fits a B-spline or
   * Bezier curve by its poles — exact, as the curve lies in a plane exactly
   * when its poles do — and any other curve by points along it.
   */
  private static fitPlane(edge: TopoDS_Edge): { origin: Point; normal: Vector3d } | null {
    const oc = getOC();
    const finder = new oc.BRepBuilderAPI_FindPlane(edge, mmTol(CurveClassifier.PLANARITY_TOLERANCE_MM));
    try {
      if (!finder.Found()) {
        return null;
      }
      const plane = finder.Plane();
      const pln = plane.Pln();
      const location = pln.Location();
      const axis = pln.Axis();
      const direction = axis.Direction();
      try {
        return {
          origin: new Point(location.X(), location.Y(), location.Z()),
          normal: new Vector3d(direction.X(), direction.Y(), direction.Z()).normalize(),
        };
      } finally {
        direction.delete();
        axis.delete();
        location.delete();
        pln.delete();
        plane.delete();
      }
    } finally {
      finder.delete();
    }
  }

  /**
   * The plane a planar curve lies in: a circle's, an arc's or an ellipse's
   * own, or the one fitted to a spline or other curve. Null for a line,
   * which lies in many, and for a curve in none.
   */
  static planeOf(curve: CurveClass): { origin: Point; normal: Vector3d } | null {
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

  private static measureLength(edge: TopoDS_Edge): number {
    const oc = getOC();
    const props = new oc.GProp_GProps();
    oc.BRepGProp.LinearProperties(edge, props, false, false);
    const length = props.Mass();
    props.delete();
    return length;
  }


}
