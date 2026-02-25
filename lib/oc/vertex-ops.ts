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
