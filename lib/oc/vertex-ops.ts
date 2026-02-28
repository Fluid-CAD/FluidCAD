import type { TopoDS_Vertex } from "occjs-wrapper";
import { getOC } from "./init.js";
import { Convert } from "./convert.js";
import { Point } from "../math/point.js";
import { Vertex } from "../common/vertex.js";

export class VertexOps {
  // Wrapper methods (public API for external callers)
  static toPoint(vertex: Vertex): Point {
    return VertexOps.toPointRaw(vertex.getShape() as TopoDS_Vertex);
  }

  static fromPoint(point: Point): Vertex {
    return Vertex.fromTopoDSVertex(VertexOps.fromPointRaw(point));
  }

  static reverse(vertex: Vertex): Vertex {
    const reversedVertex = VertexOps.reverseRaw(vertex.getShape() as TopoDS_Vertex);
    return Vertex.fromTopoDSVertex(reversedVertex);
  }

  static reverseRaw(vertex: TopoDS_Vertex): TopoDS_Vertex {
    const oc = getOC();
    const reversed = oc.TopoDS.Vertex(vertex.Reversed());
    vertex.delete();
    return reversed;
  }

  // Raw methods (for oc-internal and common/ use)
  static toPointRaw(vertex: TopoDS_Vertex): Point {
    const oc = getOC();
    const pnt = oc.BRep_Tool.Pnt(vertex);
    const r = Convert.toPoint(pnt);
    pnt.delete();
    return r;
  }

  static fromPointRaw(point: Point): TopoDS_Vertex {
    const oc = getOC();
    const [pnt, disposePnt] = Convert.toGpPnt(point);
    const vertexMaker = new oc.BRepBuilderAPI_MakeVertex(pnt);
    const vertex = vertexMaker.Vertex() as TopoDS_Vertex;
    disposePnt();
    return vertex;
  }
}
