import type { gp_Pln, gp_Vec, TopoDS_Edge, TopoDS_Shape } from "occjs-wrapper";
import { getOC } from "./init.js";
import { Convert } from "./convert.js";
import { Point } from "../math/point.js";
import { Vector3d } from "../math/vector3d.js";
import { Plane } from "../math/plane.js";
import { Shape } from "../common/shape.js";
import { Edge } from "../common/edge.js";

export class EdgeQuery {
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

  // Raw methods (for oc-internal and common/ use)
  static isCircleEdgeRaw(edge: TopoDS_Shape, diameter?: number): boolean {
    const oc = getOC();
    const ocEdge = oc.TopoDS.Edge(edge);
    const curveAdaptor = new oc.BRepAdaptor_Curve(ocEdge);

    const curveType = curveAdaptor.GetType();
    if (curveType !== oc.GeomAbs_CurveType.GeomAbs_Circle) {
      curveAdaptor.delete();
      return false;
    }

    if (!curveAdaptor.IsClosed()) {
      curveAdaptor.delete();
      return false;
    }

    if (diameter === undefined) {
      curveAdaptor.delete();
      return true;
    }

    const circle = curveAdaptor.Circle();
    const r = circle.Radius();
    circle.delete();
    curveAdaptor.delete();
    return Math.abs(r - diameter / 2) <= oc.Precision.Confusion();
  }

  static isArcEdgeRaw(edge: TopoDS_Shape, radius?: number): boolean {
    const oc = getOC();
    const ocEdge = oc.TopoDS.Edge(edge);
    const curveAdaptor = new oc.BRepAdaptor_Curve(ocEdge);

    const curveType = curveAdaptor.GetType();
    if (curveType !== oc.GeomAbs_CurveType.GeomAbs_Circle) {
      curveAdaptor.delete();
      return false;
    }

    if (curveAdaptor.IsClosed()) {
      curveAdaptor.delete();
      return false;
    }

    if (radius === undefined) {
      curveAdaptor.delete();
      return true;
    }

    const circle = curveAdaptor.Circle();
    const r = circle.Radius();
    circle.delete();
    curveAdaptor.delete();
    return Math.abs(r - radius) <= oc.Precision.Confusion();
  }

  static isLineEdgeRaw(edge: TopoDS_Shape, length?: number): boolean {
    const oc = getOC();
    const ocEdge = oc.TopoDS.Edge(edge);
    const curveAdaptor = new oc.BRepAdaptor_Curve(ocEdge);

    const curveType = curveAdaptor.GetType();
    if (curveType !== oc.GeomAbs_CurveType.GeomAbs_Line) {
      curveAdaptor.delete();
      return false;
    }

    if (length === undefined) {
      curveAdaptor.delete();
      return true;
    }

    const edgeLength = Math.abs(curveAdaptor.LastParameter() - curveAdaptor.FirstParameter());
    curveAdaptor.delete();
    return Math.abs(edgeLength - length) <= oc.Precision.Confusion();
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
    const curve = adaptor.Curve().Curve()?.get();

    if (!curve) {
      adaptor.delete();
      return false;
    }

    const firstParam = curve.FirstParameter();
    const lastParam = curve.LastParameter();
    const midParam = (firstParam + lastParam) / 2;

    const tangent = new oc.gp_Vec();
    const tempPnt = new oc.gp_Pnt();
    curve.D1(midParam, tempPnt, tangent);

    const dotProduct = Math.abs(tangent.Dot(planeNormal));

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
}
