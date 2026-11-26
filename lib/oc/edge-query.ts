import type { gp_Pln, gp_Vec, TopoDS_Edge, TopoDS_Face, TopoDS_Shape } from "ocjs-fluidcad";
import { getOC } from "./init.js";
import { Convert } from "./convert.js";
import { FaceOps } from "./face-ops.js";
import { Point } from "../math/point.js";
import { Vector3d } from "../math/vector3d.js";
import { Plane } from "../math/plane.js";
import { Shape } from "../common/shape.js";
import { Edge } from "../common/edge.js";
import { CurveClass, CurveClassifier } from "./curve-classifier.js";

/** An edge's geometry independent of its kernel representation; see {@link EdgeQuery.getEdgeGeometryRaw}. */
export type EdgeGeometry =
  | { kind: 'line'; length: number }
  | { kind: 'circle'; radius: number; closed: boolean; center: Point; axisDirection: Vector3d }
  | { kind: 'other' };

/**
 * The answers to one plane question the edge filters ask of an edge
 * (`onPlane`, `parallelTo` or `alignedWith`), keyed by the exact plane.
 * Selector synthesis asks the same ones of every edge in scope, once per
 * candidate atom, per pick. They follow from the edge's class, so they are
 * kept with it (see {@link CurveClassifier.derived}) and go when it does.
 */
function planeAnswers(edge: Shape, question: 'onPlane' | 'parallelTo' | 'alignedWith'): Map<string, boolean> {
  return CurveClassifier.derived(edge as Edge, question, () => new Map<string, boolean>());
}

function vectorKey(v: { x: number; y: number; z: number }): string {
  return `${v.x},${v.y},${v.z}`;
}

/** The answer `compute` gives for `key`, asked once. */
function remembered(answers: Map<string, boolean>, key: string, compute: () => boolean): boolean {
  let answer = answers.get(key);
  if (answer === undefined) {
    answer = compute();
    answers.set(key, answer);
  }
  return answer;
}

export class EdgeQuery {

  // Wrapper methods (public API for external callers). The predicates below
  // answer from the wrapper's cached facts; the Raw forms always ask OCCT.
  static isCircleEdge(edge: Shape, diameter?: number): boolean {
    return EdgeQuery.isCircleGeometry(EdgeQuery.cachedGeometry(edge), diameter);
  }

  static isArcEdge(edge: Shape, radius?: number): boolean {
    return EdgeQuery.isArcGeometry(EdgeQuery.cachedGeometry(edge), radius);
  }

  static isLineEdge(edge: Shape, length?: number): boolean {
    return EdgeQuery.isLineGeometry(EdgeQuery.cachedGeometry(edge), length);
  }

  static isEdgeOnPlane(edge: Shape, plane: Plane): boolean {
    return remembered(planeAnswers(edge, 'onPlane'), `${vectorKey(plane.origin)}|${vectorKey(plane.normal)}`, () => {
      if (!EdgeQuery.isLineOrCircular(edge)) {
        return EdgeQuery.isCurveOnPlane(CurveClassifier.classify(edge as Edge), plane);
      }
      const [gpPln, dispose] = Convert.toGpPln(plane);
      const result = EdgeQuery.isEdgeOnPlaneRaw(edge.getShape(), gpPln);
      dispose();
      return result;
    });
  }

  static isEdgeParallelToPlane(edge: Shape, planeNormal: Vector3d): boolean {
    return remembered(planeAnswers(edge, 'parallelTo'), vectorKey(planeNormal), () => {
      if (!EdgeQuery.isLineOrCircular(edge)) {
        return EdgeQuery.isCurveParallelToPlane(CurveClassifier.classify(edge as Edge), planeNormal);
      }
      const [gpVec, dispose] = Convert.toGpVec(planeNormal);
      const result = EdgeQuery.isEdgeParallelToPlaneRaw(edge.getShape(), gpVec);
      dispose();
      return result;
    });
  }

  static isEdgeAlignedWithNormal(edge: Shape, planeNormal: Vector3d): boolean {
    return remembered(planeAnswers(edge, 'alignedWith'), vectorKey(planeNormal), () => {
      if (!EdgeQuery.isLineOrCircular(edge)) {
        // Only a straight edge can run along a direction.
        return false;
      }
      const [gpVec, dispose] = Convert.toGpVec(planeNormal);
      const result = EdgeQuery.isEdgeAlignedWithNormalRaw(edge.getShape(), gpVec);
      dispose();
      return result;
    });
  }

  /**
   * Whether the edge is a line, a circle or an arc (native or recovered;
   * see {@link CurveClassifier}). A few points describe such an edge
   * exactly, so the plane predicates test it at those points; any other
   * curve is judged by the plane it lies in (see {@link isCurveOnPlane}),
   * and one that lies in none is on no plane and parallel to none.
   */
  static isLineOrCircular(edge: Shape): boolean {
    const kind = CurveClassifier.classify(edge as Edge).kind;
    return kind === 'line' || kind === 'circle' || kind === 'arc';
  }

  /** The wrapper's geometry, read off its {@link CurveClassifier} class (kept per wrapper there). */
  private static cachedGeometry(edge: Shape): EdgeGeometry {
    return EdgeQuery.geometryOf(CurveClassifier.classify(edge as Edge));
  }

  /** Whether the edge returns to its start; see {@link CurveClass.closed}. */
  static isEdgeClosedCurve(edge: Edge): boolean {
    return CurveClassifier.classify(edge).closed;
  }

  /**
   * The edge as a line, a circle (full or an arc) or anything else, read
   * off its {@link CurveClassifier} class: a B-spline the classifier
   * recovers as a line or a circle is one here too.
   */
  static getEdgeCurveType(edge: Edge): "line" | "circle" | "other" {
    return EdgeQuery.geometryOf(CurveClassifier.classify(edge)).kind;
  }

  static getEdgeCurveParams(edge: Edge): { first: number; last: number } {
    return EdgeQuery.getEdgeCurveParamsRaw(edge.getShape());
  }

  static sampleEdgeCurvePoint(edge: Edge, param: number): Point {
    return EdgeQuery.sampleEdgeCurvePointRaw(edge.getShape(), param);
  }

  static getCircleDataFromEdge(edge: Edge): { center: Point; radius: number; axisDirection: Vector3d } {
    return EdgeQuery.getCircleDataFromEdgeRaw(edge.getShape());
  }

  static doEdgesIntersect(edge1: Edge, edge2: Edge): boolean {
    return EdgeQuery.doEdgesIntersectRaw(edge1.getShape(), edge2.getShape());
  }

  static doesEdgeIntersectPlane(edge: Edge, plane: Plane): boolean {
    const [gpPln, dispose] = Convert.toGpPln(plane);
    const face = FaceOps.makeFaceFromPlane2(gpPln);
    const result = EdgeQuery.doesEdgeIntersectPlaneRaw(edge.getShape() as TopoDS_Edge, face);
    face.delete();
    dispose();
    return result;
  }

  // Raw methods (for oc-internal and common/ use)
  static isCircleEdgeRaw(edge: TopoDS_Shape, diameter?: number): boolean {
    return EdgeQuery.isCircleGeometry(EdgeQuery.getEdgeGeometryRaw(edge), diameter);
  }

  static isArcEdgeRaw(edge: TopoDS_Shape, radius?: number): boolean {
    return EdgeQuery.isArcGeometry(EdgeQuery.getEdgeGeometryRaw(edge), radius);
  }

  static isLineEdgeRaw(edge: TopoDS_Shape, length?: number): boolean {
    return EdgeQuery.isLineGeometry(EdgeQuery.getEdgeGeometryRaw(edge), length);
  }

  private static isCircleGeometry(geometry: EdgeGeometry, diameter?: number): boolean {
    if (geometry.kind !== 'circle' || !geometry.closed) {
      return false;
    }
    return diameter === undefined || EdgeQuery.sameLength(geometry.radius, diameter / 2);
  }

  private static isArcGeometry(geometry: EdgeGeometry, radius?: number): boolean {
    if (geometry.kind !== 'circle' || geometry.closed) {
      return false;
    }
    return radius === undefined || EdgeQuery.sameLength(geometry.radius, radius);
  }

  private static isLineGeometry(geometry: EdgeGeometry, length?: number): boolean {
    if (geometry.kind !== 'line') {
      return false;
    }
    return length === undefined || EdgeQuery.sameLength(geometry.length, length);
  }

  /**
   * The edge's geometry, regardless of how the kernel stores it: its
   * {@link CurveClassifier} class, as a line, a circle (closed or an arc) or
   * `other`. A B-spline or Bezier edge — what lofts, sweeps and STEP imports
   * carry even for straight segments and circular arcs — is a line or a
   * circle when the classifier recovers one from it.
   */
  static getEdgeGeometryRaw(edge: TopoDS_Shape): EdgeGeometry {
    return EdgeQuery.geometryOf(CurveClassifier.classifyRaw(edge));
  }

  /** A curve class as the line / circle / other geometry the edge filters read. */
  private static geometryOf(curve: CurveClass): EdgeGeometry {
    if (curve.kind === 'line') {
      return { kind: 'line', length: curve.length };
    }
    if ((curve.kind === 'circle' || curve.kind === 'arc') && curve.radius !== undefined && curve.center && curve.axisDirection) {
      return {
        kind: 'circle',
        radius: curve.radius,
        closed: curve.kind === 'circle',
        center: curve.center,
        axisDirection: curve.axisDirection,
      };
    }
    return { kind: 'other' };
  }

  /** How closely a measured length or radius must match a requested one; see {@link CurveClassifier.tolerance}. */
  private static sameLength(measured: number, requested: number): boolean {
    return Math.abs(measured - requested) <= CurveClassifier.tolerance();
  }

  static isEdgeOnPlaneRaw(edge: TopoDS_Shape, plane: gp_Pln): boolean {
    const oc = getOC();
    const ocEdge = oc.TopoDS.Edge(edge);
    const curveAdaptor = new oc.BRepAdaptor_Curve(ocEdge);
    // The adaptor holds its own reference to the edge; the typed copy goes.
    ocEdge.delete();

    const uMin = curveAdaptor.FirstParameter();
    const uMax = curveAdaptor.LastParameter();
    const uMid = (uMin + uMax) / 2.0;

    const parameters = [uMin, uMid, uMax];
    let allOnPlane = true;

    for (const u of parameters) {
      const point = curveAdaptor.Value(u);
      const distance = plane.Distance(point);

      if (Math.abs(distance) > oc.Precision.Confusion()) {
        allOnPlane = false;
        point.delete();
        break;
      }

      point.delete();
    }

    curveAdaptor.delete();
    return allOnPlane;
  }

  /**
   * Whether a curve other than a line or a circular one lies on `plane`:
   * the plane it lies in (an ellipse's own, or the one OCC fits to a spline,
   * see {@link CurveClassifier.planeOf}) is `plane`, within OCCT's confusion
   * tolerance over the whole curve. The two planes may tilt against each
   * other within the angular bound and still drift apart along a long
   * curve, so the far end is bounded too: no point of the curve is farther
   * from its plane's origin than `reach`, which a tilt lifts off `plane` by
   * at most sin(angle) × reach. A curve in no plane lies on none.
   */
  static isCurveOnPlane(curve: CurveClass, plane: Plane): boolean {
    const own = CurveClassifier.planeOf(curve);
    if (!own) {
      return false;
    }
    const tolerance = getOC().Precision.Confusion();
    const offset = Math.abs(plane.signedDistanceToPoint(own.origin));
    if (offset > tolerance || !EdgeQuery.sameNormal(own.normal, plane.normal)) {
      return false;
    }
    // An ellipse's plane stands on its centre, a fitted plane on the
    // curve's own start point.
    const reach = curve.kind === 'ellipse' ? curve.majorRadius ?? 0 : curve.length;
    const sine = own.normal.normalize().cross(plane.normal.normalize()).length();
    return offset + sine * reach <= tolerance;
  }

  /**
   * Whether a curve other than a line or a circular one lies in a plane
   * parallel to the one with normal `planeNormal`: the plane it lies in has
   * that normal, either way round.
   */
  static isCurveParallelToPlane(curve: CurveClass, planeNormal: Vector3d): boolean {
    const own = CurveClassifier.planeOf(curve);
    return own !== null && EdgeQuery.sameNormal(own.normal, planeNormal);
  }

  /** Two plane normals along one line, either way round. */
  private static sameNormal(a: Vector3d, b: Vector3d): boolean {
    // unit: dimensionless (cross of unit vectors)
    return a.normalize().cross(b.normalize()).length() < 1e-6;
  }

  static isEdgeParallelToPlaneRaw(edge: TopoDS_Shape, planeNormal: gp_Vec): boolean {
    const oc = getOC();
    const ocEdge = oc.TopoDS.Edge(edge);
    const adaptor = new oc.BRepAdaptor_Curve(ocEdge);
    ocEdge.delete();

    const firstParam = adaptor.FirstParameter();
    const lastParam = adaptor.LastParameter();
    const midParam = (firstParam + lastParam) / 2;

    const tangent = new oc.gp_Vec();
    const tempPnt = new oc.gp_Pnt();
    adaptor.D1(midParam, tempPnt, tangent);

    const dotProduct = Math.abs(tangent.Dot(planeNormal));

    // unit: dimensionless (dot of unit vectors)
    const tolerance = 1e-6;
    const result = dotProduct < tolerance;

    tangent.delete();
    tempPnt.delete();
    adaptor.delete();

    return result;
  }

  static isEdgeAlignedWithNormalRaw(edge: TopoDS_Shape, planeNormal: gp_Vec): boolean {
    const oc = getOC();
    const ocEdge = oc.TopoDS.Edge(edge);
    const curveAdaptor = new oc.BRepAdaptor_Curve(ocEdge);
    ocEdge.delete();

    const uMin = curveAdaptor.FirstParameter();
    const uMax = curveAdaptor.LastParameter();

    const startPoint = curveAdaptor.Value(uMin);
    const endPoint = curveAdaptor.Value(uMax);

    const edgeVector = new oc.gp_Vec(startPoint, endPoint);

    if (edgeVector.Magnitude() < oc.Precision.Confusion()) {
      edgeVector.delete();
      startPoint.delete();
      endPoint.delete();
      curveAdaptor.delete();
      return false;
    }

    edgeVector.Normalize();

    const planeNormalDir = new oc.gp_Dir(planeNormal.X(), planeNormal.Y(), planeNormal.Z());
    const edgeDir = new oc.gp_Dir(edgeVector.X(), edgeVector.Y(), edgeVector.Z());
    const reversedNormal = planeNormalDir.Reversed();

    const equals = edgeDir.IsEqual(planeNormalDir, oc.Precision.Angular())
      || edgeDir.IsEqual(reversedNormal, oc.Precision.Angular());

    edgeVector.delete();
    startPoint.delete();
    endPoint.delete();
    planeNormalDir.delete();
    edgeDir.delete();
    reversedNormal.delete();
    curveAdaptor.delete();

    return equals;
  }

  /**
   * Whether the kernel stores the edge as a line. For constructions that
   * are exact only on a true line (a sweep's mitred corner, its constant
   * frame along a straight spine); everything else asks
   * {@link getEdgeCurveType}, which also knows a straight B-spline.
   */
  static isStoredLineRaw(edge: TopoDS_Edge): boolean {
    const oc = getOC();
    const curve = new oc.BRepAdaptor_Curve(edge);
    try {
      return curve.GetType() === oc.GeomAbs_CurveType.GeomAbs_Line;
    } finally {
      curve.delete();
    }
  }

  static getEdgeCurveParamsRaw(edge: TopoDS_Edge): { first: number; last: number } {
    const oc = getOC();
    const curve = new oc.BRepAdaptor_Curve(edge);
    const first = curve.FirstParameter();
    const last = curve.LastParameter();
    curve.delete();
    return { first, last };
  }

  static sampleEdgeCurvePointRaw(edge: TopoDS_Edge, param: number): Point {
    const oc = getOC();
    const curve = new oc.BRepAdaptor_Curve(edge);
    const gp = curve.Value(param);
    const point = new Point(gp.X(), gp.Y(), gp.Z());
    gp.delete();
    curve.delete();
    return point;
  }

  /**
   * Center, radius and axis of a circular edge — native or a B-spline that
   * {@link getEdgeGeometryRaw} recovers as a circle, so every caller that
   * classified the edge through that recovery can read its circle too.
   */
  static getCircleDataFromEdgeRaw(edge: TopoDS_Edge): { center: Point; radius: number; axisDirection: Vector3d } {
    const geometry = EdgeQuery.getEdgeGeometryRaw(edge);
    if (geometry.kind !== 'circle') {
      throw new Error(`edge is not a circle or arc (got '${geometry.kind}')`);
    }
    return { center: geometry.center, radius: geometry.radius, axisDirection: geometry.axisDirection };
  }

  static doEdgesIntersectRaw(edge1: TopoDS_Edge, edge2: TopoDS_Edge): boolean {
    const oc = getOC();
    const tool = new oc.IntTools_EdgeEdge(edge1, edge2);
    tool.Perform();

    let intersects = false;
    if (tool.IsDone()) {
      const parts = tool.CommonParts();
      intersects = parts.Length() > 0;
      parts.delete();
    }

    tool.delete();
    return intersects;
  }

  static doesEdgeIntersectPlaneRaw(edge: TopoDS_Edge, face: TopoDS_Face): boolean {
    const oc = getOC();
    const tool = new oc.IntTools_EdgeFace();
    tool.SetEdge(edge);
    tool.SetFace(face);
    tool.Perform();

    let intersects = false;
    if (tool.IsDone()) {
      const parts = tool.CommonParts();
      intersects = parts.Length() > 0;
      parts.delete();
    }

    tool.delete();
    return intersects;
  }
}
