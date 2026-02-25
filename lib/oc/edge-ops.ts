import type { TopoDS_Edge, TopoDS_Vertex } from "occjs-wrapper";
import { getOC } from "./init.js";
import { Convert } from "./convert.js";
import { Axis } from "../math/axis.js";
import { Point } from "../math/point.js";
import { Vector3d } from "../math/vector3d.js";
import { Edge } from "../common/edge.js";
import { Vertex } from "../common/vertex.js";

export class EdgeOps {
  // Wrapper methods (public API for external callers)
  static getFirstVertex(edge: Edge): Vertex {
    return Vertex.fromTopoDSVertex(EdgeOps.getFirstVertexRaw(edge.getShape() as TopoDS_Edge));
  }

  static getLastVertex(edge: Edge): Vertex {
    return Vertex.fromTopoDSVertex(EdgeOps.getLastVertexRaw(edge.getShape() as TopoDS_Edge));
  }

  static edgeToAxis(edge: Edge): Axis {
    return EdgeOps.edgeToAxisRaw(edge.getShape() as TopoDS_Edge);
  }

  static axisToEdge(axis: Axis): Edge {
    return Edge.fromTopoDSEdge(EdgeOps.axisToEdgeRaw(axis));
  }

  static getVertexPoint(vertex: Vertex): Point {
    return EdgeOps.getVertexPointRaw(vertex.getShape() as TopoDS_Vertex);
  }

  static getEdgeMidPoint(edge: Edge): Point {
    return EdgeOps.getEdgeMidPointRaw(edge.getShape() as TopoDS_Edge);
  }

  static reverseEdge(edge: Edge): Edge {
    return Edge.fromTopoDSEdge(EdgeOps.reverseEdgeRaw(edge.getShape() as TopoDS_Edge));
  }

  static getEdgeOrientation(edge: Edge): number {
    return EdgeOps.getEdgeOrientationRaw(edge.getShape() as TopoDS_Edge);
  }

  static getEdgeTangentAtEnd(edge: Edge): Vector3d {
    return EdgeOps.getEdgeTangentAtEndRaw(edge.getShape() as TopoDS_Edge);
  }

  static makeEdgeFromCurveAndVertices(curve: any, v1: Vertex, v2: Vertex): Edge {
    return Edge.fromTopoDSEdge(
      EdgeOps.makeEdgeFromCurveAndVerticesRaw(curve, v1.getShape() as TopoDS_Vertex, v2.getShape() as TopoDS_Vertex)
    );
  }

  // Raw methods (for oc-internal and common/ use)
  static getFirstVertexRaw(edge: TopoDS_Edge): TopoDS_Vertex {
    const oc = getOC();
    return oc.TopExp.FirstVertex(edge, true);
  }

  static getLastVertexRaw(edge: TopoDS_Edge): TopoDS_Vertex {
    const oc = getOC();
    return oc.TopExp.LastVertex(edge, true);
  }

  static edgeToAxisRaw(edge: TopoDS_Edge): Axis {
    const oc = getOC();

    const topoEdge = oc.TopoDS.Edge(edge);
    const curveAdaptor = new oc.BRepAdaptor_Curve(topoEdge);

    if (curveAdaptor.GetType() === oc.GeomAbs_CurveType.GeomAbs_Line) {
      const line = curveAdaptor.Line();
      const axis = line.Position();

      curveAdaptor.delete();
      line.delete();

      const axisLocation = axis.Location();
      const axisDirection = axis.Direction();

      const result = new Axis(
        Convert.toPoint(axisLocation),
        Convert.toVector3dFromGpDir(axisDirection)
      );

      axisLocation.delete();
      axisDirection.delete();
      axis.delete();

      return result;
    }

    curveAdaptor.delete();
    throw new Error("Edge does not represent a line and cannot be converted to an axis");
  }

  static axisToEdgeRaw(axis: Axis): TopoDS_Edge {
    const oc = getOC();

    const length = 300;

    const start = new oc.gp_Pnt(axis.origin.x + (axis.direction.x * -length),
      axis.origin.y + (axis.direction.y * -length),
      axis.origin.z + (axis.direction.z * -length)
    );

    const end = new oc.gp_Pnt(
      axis.origin.x + (axis.direction.x * length),
      axis.origin.y + (axis.direction.y * length),
      axis.origin.z + (axis.direction.z * length),
    );

    const edgeMaker = new oc.BRepBuilderAPI_MakeEdge(start, end);
    const edge = edgeMaker.Edge();
    edgeMaker.delete();

    return edge;
  }

  static edgeMiddlePoint(edge: TopoDS_Edge) {
    const oc = getOC();

    const curveAdaptor = new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(edge));
    const curve = curveAdaptor.Curve();

    const midParam = (curve.FirstParameter() + curve.LastParameter()) / 2.0;
    const midPoint = curve.Value(midParam);

    const result = new oc.gp_Pnt(midPoint.X(), midPoint.Y(), midPoint.Z());

    curveAdaptor.delete();

    return result;
  }

  static getVertexPointRaw(vertex: TopoDS_Vertex): Point {
    const oc = getOC();
    const pnt = oc.BRep_Tool.Pnt(vertex);
    const result = new Point(pnt.X(), pnt.Y(), pnt.Z());
    pnt.delete();
    return result;
  }

  static getEdgeMidPointRaw(edge: TopoDS_Edge): Point {
    const oc = getOC();
    const adaptor = new oc.BRepAdaptor_Curve(edge);
    const mid = adaptor.Value((adaptor.FirstParameter() + adaptor.LastParameter()) / 2);
    const result = new Point(mid.X(), mid.Y(), mid.Z());
    mid.delete();
    adaptor.delete();
    return result;
  }

  static reverseEdgeRaw(edge: TopoDS_Edge): TopoDS_Edge {
    const oc = getOC();
    return oc.TopoDS.Edge(edge.Reversed());
  }

  static getEdgeOrientationRaw(edge: TopoDS_Edge): number {
    const oc = getOC();
    return edge.Orientation() === oc.TopAbs_Orientation.TopAbs_REVERSED ? -1 : 1;
  }

  static getEdgeTangentAtEndRaw(edge: TopoDS_Edge): Vector3d {
    const oc = getOC();
    const isReversed = edge.Orientation() === oc.TopAbs_Orientation.TopAbs_REVERSED;
    const curveHandle = oc.BRep_Tool.Curve(edge, 0, 1);
    const curve = curveHandle.get();
    const param = isReversed ? curve.FirstParameter() : curve.LastParameter();
    const edgeSign = isReversed ? -1 : 1;

    const tangentVec = new oc.gp_Vec();
    const pnt = new oc.gp_Pnt();
    curve.D1(param, pnt, tangentVec);
    const result = Convert.toVector3d(tangentVec, true).multiply(edgeSign);
    pnt.delete();

    return result;
  }

  static makeEdgeFromCurveAndVerticesRaw(curve: any, v1: TopoDS_Vertex, v2: TopoDS_Vertex): TopoDS_Edge {
    const oc = getOC();
    const handle = new oc.Handle_Geom_Curve(curve);
    const edgeMaker = new oc.BRepBuilderAPI_MakeEdge(handle, v1, v2);
    const edge = edgeMaker.Edge();
    edgeMaker.delete();
    handle.delete();
    return edge;
  }
}
