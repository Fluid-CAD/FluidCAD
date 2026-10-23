import { ShapeType } from "./shape-type.js";
import type { TopoDS_Edge } from "ocjs-fluidcad";
import { Shape } from "./shape.js";
import { EdgeOps } from "../oc/edge-ops.js";
import { Vertex } from "./vertex.js";
import type { Point } from "../math/point.js";

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
    if (type === 'edge') {
      return [this];
    }

    return [];
  }

  /** A fresh wrapper of the edge's first vertex — the caller's to dispose. */
  getFirstVertex(): Vertex {
    return Vertex.fromTopoDSVertex(EdgeOps.getFirstVertexRaw(this.getShape()));
  }

  /** A fresh wrapper of the edge's last vertex — the caller's to dispose. */
  getLastVertex(): Vertex {
    return Vertex.fromTopoDSVertex(EdgeOps.getLastVertexRaw(this.getShape()));
  }

  /** Where the edge starts; the vertex read for it is freed here. */
  getFirstPoint(): Point {
    const vertex = this.getFirstVertex();
    try {
      return vertex.toPoint();
    } finally {
      vertex.dispose();
    }
  }

  /** Where the edge ends; the vertex read for it is freed here. */
  getLastPoint(): Point {
    const vertex = this.getLastVertex();
    try {
      return vertex.toPoint();
    } finally {
      vertex.dispose();
    }
  }

  isClosed(): boolean {
    return EdgeOps.isClosed(this);
  }

  static fromTopoDSEdge(edge: TopoDS_Edge): Edge {
    return new Edge(edge);
  }
}
