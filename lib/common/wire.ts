import type { TopoDS_Wire } from "occjs-wrapper";
import { WireOps } from "../oc/wire-ops.js";
import { ShapeType } from "./shape-type.js";
import { Shape } from "./shape.js";
import { Vector3d } from "../math/vector3d.js";
import { Vertex } from "./vertex.js";
import { Explorer } from "../oc/explorer.js";

export class Wire extends Shape<TopoDS_Wire> {
  vertices: Vertex[] | null = null;

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
