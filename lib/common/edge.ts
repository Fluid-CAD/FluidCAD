import { ShapeType } from "./shape-type.js";
import type { TopoDS_Edge } from "occjs-wrapper";
import { Shape } from "./shape.js";
import { EdgeOps } from "../oc/edge-ops.js";
import { Vertex } from "./vertex.js";

export class Edge extends Shape<TopoDS_Edge> {
  constructor(edge: TopoDS_Edge) {
    super(edge);
  }

  getType(): ShapeType {
    return "edge";
  }

  isEdge(): boolean {
    return true;
  }

  getSubShapes(type: ShapeType): Shape[] {
    throw new Error("Method not implemented.");
  }

  getFirstVertex(): Vertex {
    return Vertex.fromTopoDSVertex(EdgeOps.getFirstVertexRaw(this.getShape()));
  }

  getLastVertex(): Vertex {
    return Vertex.fromTopoDSVertex(EdgeOps.getLastVertexRaw(this.getShape()));
  }

  isClosed(): boolean {
    return EdgeOps.isClosed(this);
  }

  static fromTopoDSEdge(edge: TopoDS_Edge): Edge {
    return new Edge(edge);
  }
}
