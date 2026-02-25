import type { TopoDS_Edge, TopoDS_Face } from "occjs-wrapper";
import { Explorer } from "../oc/explorer.js";
import { FaceOps } from "../oc/face-ops.js";
import { ShapeOps } from "../oc/shape-ops.js";
import { BoundingBox } from "../helpers/types.js";
import { ShapeType } from "./shape-type.js";
import { Wire } from "./wire.js";
import { Point } from "../math/point.js";
import { Plane } from "../math/plane.js";
import { Shape } from "./shape.js";
import { Edge } from "./edge.js";
import { Vector3d } from "../math/vector3d.js";

export class Face extends Shape<TopoDS_Face> {
  protected normal: Vector3d = null;
  protected boundingBox: BoundingBox = null;

  private edges: Edge[] = null;
  private wires: Wire[] = null;

  constructor(face: TopoDS_Face) {
    super(face);
  }

  getType(): ShapeType {
    return "face";
  }

  override isFace(): boolean {
    return true;
  }

  getSubShapes(type: ShapeType): Shape[] {
    if (type === 'face') {
      return [this];
    }
    else if (type === 'edge') {
      return this.getEdges();
    }

    return [];
  }

  getEdges(): Edge[] {
    if (this.edges) {
      return this.edges;
    }

    this.edges = Explorer.findEdgesWrapped(this);
    return this.edges;
  }

  getWires(): Wire[] {
    if (this.wires) {
      return this.wires;
    }

    this.wires = Explorer.findWiresWrapped(this);
    return this.wires;
  }

  hasEdge(edge: TopoDS_Edge): Edge {
    const edges = this.getEdges();
    return edges.find(e => e.getShape().IsPartner(edge)) || null;
  }

  getNormal(): Vector3d {
    return this.normal;
  }

  getBoundingBox(): BoundingBox {
    if (this.boundingBox) {
      return this.boundingBox;
    }

    this.boundingBox = ShapeOps.getBoundingBox(this.getShape());
    return this.boundingBox;
  }

  center() {
    const bbox = this.getBoundingBox();
    return new Point(
      (bbox.minX + bbox.maxX) / 2,
      (bbox.minY + bbox.maxY) / 2,
      (bbox.minZ + bbox.maxZ) / 2
    );
  }

  static fromTopoDSFace(face: TopoDS_Face): Face {
    return new Face(face);
  }

  getPlane(): Plane {
    return FaceOps.getPlane(this.getShape());
  }

  getFaces(): TopoDS_Face[] {
    return [this.getShape()];
  }

  calculateNormal() {
    return FaceOps.calculateNormal(this.getShape());
  }

  compareTo(other: Face): boolean {
    if (!(other instanceof Face)) {
      return false;
    }

    return this.getShape().IsPartner(other.getShape());
  }

  serialize() {
    return {}
  }
}
