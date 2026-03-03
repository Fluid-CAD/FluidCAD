import type { TopoDS_Wire } from "occjs-wrapper";
import { WireOps } from "../oc/wire-ops.js";
import { ShapeType } from "./shape-type.js";
import { Shape } from "./shape.js";
import { Vector3d } from "../math/vector3d.js";
import { Vertex } from "./vertex.js";
import { Explorer } from "../oc/explorer.js";
import { Edge } from "./edge.js";

export class Wire extends Shape<TopoDS_Wire> {
  vertices: Vertex[] | null = null;
  edges: Edge[] | null = null;

  constructor(wire: TopoDS_Wire) {
    super(wire);
  }

  getType(): ShapeType {
    return "wire";
  }

  override isWire(): boolean {
    return true;
  }

  isCW(normal: Vector3d): boolean {
    return WireOps.isCW(this, normal);
  }

  getSubShapes(type: ShapeType): Shape[] {
    return [];
  }

  getEdges() {
    if (this.edges) {
      return this.edges;
    }

    this.edges = Explorer.findEdgesWrapped(this);
    return this.edges;
  }

  getFirstVertex(): Vertex {
    const edges = this.getEdges();
    if (edges.length === 0) {
      return null;
    }

    const firstEdge = edges[0];
    return firstEdge.getFirstVertex();
  }

  getLastVertex(): Vertex {
    const edges = this.getEdges();
    if (edges.length === 0) {
      return null;
    }

    const lastEdge = edges[edges.length - 1];
    return lastEdge.getLastVertex();
  }

  static fromTopoDSWire(wire: TopoDS_Wire): Wire {
    return new Wire(wire);
  }

  isClosed(): boolean {
    return this.getShape().Closed();
  }

  getVertices() {
    if (this.vertices) {
      return this.vertices;
    }

    this.vertices = Explorer.findVerticesWrapped(this);
    return this.vertices;
  }
}
