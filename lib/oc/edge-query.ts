import type { gp_Pln, gp_Vec, TopoDS_Edge, TopoDS_Face, TopoDS_Shape } from "ocjs-fluidcad";
import { getOC } from "./init.js";
import { Convert } from "./convert.js";
import { FaceOps } from "./face-ops.js";
import { Point } from "../math/point.js";
import { Vector3d } from "../math/vector3d.js";
import { Plane } from "../math/plane.js";
import { Shape } from "../common/shape.js";
import { Edge } from "../common/edge.js";
import { mmTol } from "../units/tolerance.js";

/** An edge's geometry independent of its kernel representation; see {@link EdgeQuery.getEdgeGeometryRaw}. */
export type EdgeGeometry =
  | { kind: 'line'; length: number }
  | { kind: 'circle'; radius: number; closed: boolean }
  | { kind: 'other' };

export class EdgeQuery {

  /** See {@link EdgeQuery.geometryTolerance}. */
  private static readonly GEOMETRY_TOLERANCE_MM = 1e-3;

  // Wrapper methods (public API for external callers)
  static isCircleEdge(edge: Shape, diameter?: number): boolean {
    return EdgeQuery.isCircleEdgeRaw(edge.getShape(), diameter);
  }

  static isArcEdge(edge: Shape, radius?: number): boolean {
    return EdgeQuery.isArcEdgeRaw(edge.getShape(), radius);
  }

  static isLineEdge(edge: Shape, length?: number): boolean {
    return EdgeQuery.isLineEdgeRaw(edge.getShape(), length);
  }

  static isEdgeOnPlane(edge: Shape, plane: Plane): boolean {
    const [gpPln, dispose] = Convert.toGpPln(plane);
    const result = EdgeQuery.isEdgeOnPlaneRaw(edge.getShape(), gpPln);
    dispose();
    return result;
  }

  static isEdgeParallelToPlane(edge: Shape, planeNormal: Vector3d): boolean {
    const [gpVec, dispose] = Convert.toGpVec(planeNormal);
    const result = EdgeQuery.isEdgeParallelToPlaneRaw(edge.getShape(), gpVec);
    dispose();
    return result;
  }

  static isEdgeAlignedWithNormal(edge: Shape, planeNormal: Vector3d): boolean {
    const [gpVec, dispose] = Convert.toGpVec(planeNormal);
    const result = EdgeQuery.isEdgeAlignedWithNormalRaw(edge.getShape(), gpVec);
    dispose();
    return result;
  }

  static isEdgeClosedCurve(edge: Edge): boolean {
    return EdgeQuery.isEdgeClosedCurveRaw(edge.getShape());
  }

  static getEdgeCurveType(edge: Edge): "line" | "circle" | "other" {
    return EdgeQuery.getEdgeCurveTypeRaw(edge.getShape());
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
    const geometry = EdgeQuery.getEdgeGeometryRaw(edge);
    if (geometry.kind !== 'circle' || !geometry.closed) {
      return false;
    }
    return diameter === undefined || EdgeQuery.sameLength(geometry.radius, diameter / 2);
  }

  static isArcEdgeRaw(edge: TopoDS_Shape, radius?: number): boolean {
    const geometry = EdgeQuery.getEdgeGeometryRaw(edge);
    if (geometry.kind !== 'circle' || geometry.closed) {
      return false;
    }
    return radius === undefined || EdgeQuery.sameLength(geometry.radius, radius);
  }

  static isLineEdgeRaw(edge: TopoDS_Shape, length?: number): boolean {
    const geometry = EdgeQuery.getEdgeGeometryRaw(edge);
    if (geometry.kind !== 'line') {
      return false;
    }
    return length === undefined || EdgeQuery.sameLength(geometry.length, length);
  }

  /**
   * The edge's geometry, regardless of how the kernel stores it. A native
   * line or circle reads straight off the curve adaptor. A B-spline or
   * Bezier edge — what lofts, sweeps and STEP imports carry even for
   * straight segments and circular arcs — is handed to OCC's analytical
   * converter, which recovers the line or circle it approximates within
   * {@link GEOMETRY_TOLERANCE_MM}; anything it cannot recover stays `other`.
   */
  static getEdgeGeometryRaw(edge: TopoDS_Shape): EdgeGeometry {
    const oc = getOC();
    const ocEdge = oc.TopoDS.Edge(edge);
    const adaptor = new oc.BRepAdaptor_Curve(ocEdge);
    try {
      const type = adaptor.GetType();
      if (type === oc.GeomAbs_CurveType.GeomAbs_Line) {
        return { kind: 'line', length: Math.abs(adaptor.LastParameter() - adaptor.FirstParameter()) };
      }
      if (type === oc.GeomAbs_CurveType.GeomAbs_Circle) {
        const circle = adaptor.Circle();
        const radius = circle.Radius();
        circle.delete();
        return { kind: 'circle', radius, closed: adaptor.IsClosed() };
      }
      if (type === oc.GeomAbs_CurveType.GeomAbs_BSplineCurve || type === oc.GeomAbs_CurveType.GeomAbs_BezierCurve) {
        return EdgeQuery.recoverAnalyticalGeometry(ocEdge, adaptor.IsClosed());
      }
      return { kind: 'other' };
    } finally {
      adaptor.delete();
    }
  }

  private static recoverAnalyticalGeometry(edge: TopoDS_Edge, closed: boolean): EdgeGeometry {
    const oc = getOC();
    const curve = oc.BRep_Tool.Curve(edge, 0, 1);
    const converter = new oc.GeomConvert_CurveToAnaCurve(curve.returnValue);
    converter.SetConvType(oc.GeomConvert_ConvType.GeomConvert_Simplest);
    const converted = converter.ConvertToAnalytical(EdgeQuery.geometryTolerance(), curve.First, curve.Last);
    try {
      if (!converted.returnValue) {
        return { kind: 'other' };
      }
      const analytical = new oc.GeomAdaptor_Curve(converted.theResultCurve);
      try {
        const type = analytical.GetType();
        if (type === oc.GeomAbs_CurveType.GeomAbs_Line) {
          return { kind: 'line', length: Math.abs(converted.newL - converted.newF) };
        }
        if (type === oc.GeomAbs_CurveType.GeomAbs_Circle) {
          const circle = analytical.Circle();
          const radius = circle.Radius();
          circle.delete();
          return { kind: 'circle', radius, closed };
        }
        return { kind: 'other' };
      } finally {
        analytical.delete();
      }
    } finally {
      converted[Symbol.dispose]();
      converter.delete();
      curve[Symbol.dispose]();
    }
  }

  /**
   * How far a B-spline may stray from the line or circle it stands for, and
   * how closely a measured length or radius must match a requested one. A
   * loft approximates its section arcs to a few 1e-5 mm, so 1e-3 mm keeps
   * them recognisable while staying far below any feature size.
   */
  private static geometryTolerance(): number {
    return mmTol(EdgeQuery.GEOMETRY_TOLERANCE_MM);
  }

  private static sameLength(measured: number, requested: number): boolean {
    return Math.abs(measured - requested) <= EdgeQuery.geometryTolerance();
  }

  static isEdgeOnPlaneRaw(edge: TopoDS_Shape, plane: gp_Pln): boolean {
    const oc = getOC();
    const ocEdge = oc.TopoDS.Edge(edge);
    const curveAdaptor = new oc.BRepAdaptor_Curve(ocEdge);

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

  static isEdgeParallelToPlaneRaw(edge: TopoDS_Shape, planeNormal: gp_Vec): boolean {
    const oc = getOC();
    const ocEdge = oc.TopoDS.Edge(edge);
    const adaptor = new oc.BRepAdaptor_Curve(ocEdge);

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

  static isEdgeClosedCurveRaw(edge: TopoDS_Edge): boolean {
    const oc = getOC();
    const curve = new oc.BRepAdaptor_Curve(edge);
    const result = curve.IsClosed();
    curve.delete();
    return result;
  }

  static getEdgeCurveTypeRaw(edge: TopoDS_Edge): "line" | "circle" | "other" {
    const oc = getOC();
    const curve = new oc.BRepAdaptor_Curve(edge);
    const curveType = curve.GetType();
    curve.delete();

    if (curveType === oc.GeomAbs_CurveType.GeomAbs_Line) return "line";
    if (curveType === oc.GeomAbs_CurveType.GeomAbs_Circle) return "circle";
    return "other";
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

  static getCircleDataFromEdgeRaw(edge: TopoDS_Edge) {
    const oc = getOC();
    const curve = new oc.BRepAdaptor_Curve(edge);
    const circle = curve.Circle();
    const center = circle.Location();
    const radius = circle.Radius();
    const axis = circle.Axis();
    const dir = axis.Direction();

    const result = {
      center: new Point(center.X(), center.Y(), center.Z()),
      radius,
      axisDirection: new Vector3d(dir.X(), dir.Y(), dir.Z()),
    };

    dir.delete();
    axis.delete();
    center.delete();
    circle.delete();
    curve.delete();
    return result;
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
