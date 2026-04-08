import type { TopoDS_Wire } from "occjs-wrapper";
import { WireOps } from "../oc/wire-ops.js";
import { ShapeType } from "./shape-type.js";
import { Shape } from "./shape.js";
import { Vector3d } from "../math/vector3d.js";
import { Vertex } from "./vertex.js";
import { Explorer } from "../oc/explorer.js";
import { Edge } from "./edge.js";
import { EdgeOps } from "../oc/edge-ops.js";

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
    if (type === 'edge') {
      return this.getEdges();
    }

    if (type === 'wire') {
      return [this];
    }

    return [];
  }

  getEdges() {
    if (this.edges) {
      return this.edges;
    }

    // Use BRepTools_WireExplorer (via findEdgesInWireOrderWrapped) instead of
    // TopExp_Explorer to get edges in wire-parametric order. TopExp_Explorer
    // returns edges in topology-graph order which varies depending on how the
    // shape was constructed (e.g. mirrored vs original extrusions).
    let edges = Explorer.findEdgesInWireOrderWrapped(this);

    // For closed wires, the starting edge from BRepTools_WireExplorer is still
    // construction-dependent. Normalize by rotating to start from the edge with
    // the lexicographically smallest midpoint, making indices geometry-based.
    if (this.isClosed() && edges.length > 1) {
      edges = Wire.normalizeStartEdge(edges);
    }

    this.edges = edges;
    return this.edges;
  }

  // Rotates the edge list so it starts from the edge with the smallest midpoint
  // (lexicographic x → y → z). This ensures consistent indexing regardless of
  // how OCCT constructed the wire internally.
  private static normalizeStartEdge(edges: Edge[]): Edge[] {
    const eps = 1e-10;
    let minIdx = 0;
    let minMid = EdgeOps.getEdgeMidPoint(edges[0]);

    for (let i = 1; i < edges.length; i++) {
      const mid = EdgeOps.getEdgeMidPoint(edges[i]);
      if (mid.x < minMid.x - eps
          || (Math.abs(mid.x - minMid.x) < eps && mid.y < minMid.y - eps)
          || (Math.abs(mid.x - minMid.x) < eps && Math.abs(mid.y - minMid.y) < eps && mid.z < minMid.z - eps)) {
        minIdx = i;
        minMid = mid;
      }
    }

    if (minIdx === 0) {
      return edges;
    }

    return [...edges.slice(minIdx), ...edges.slice(0, minIdx)];
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
