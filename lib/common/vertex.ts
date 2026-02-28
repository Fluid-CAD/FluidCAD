import type { TopoDS_Vertex } from "occjs-wrapper";
import { ShapeType } from "./shape-type.js";
import { Shape } from "./shape.js";
import { Point, Point2D } from "../math/point.js";
import { VertexOps } from "../oc/vertex-ops.js";

export class Vertex extends Shape<TopoDS_Vertex> {
  constructor(vertex: TopoDS_Vertex) {
    super(vertex);
  }

  getType(): ShapeType {
    return "vertex";
  }

  override isVertex(): boolean {
    return true;
  }

  toPoint(): Point {
    return VertexOps.toPointRaw(this.getShape());
  }

  toPoint2D(): Point2D {
    const p = this.toPoint();
    return new Point2D(p.x, p.y);
  }

  reverse(): Vertex {
    const p = this.toPoint2D();
    return Vertex.fromPoint2D(new Point2D(-p.x, -p.y));
  }

  getSubShapes(): Shape[] {
    return [];
  }

  static fromTopoDSVertex(vertex: TopoDS_Vertex): Vertex {
    return new Vertex(vertex);
  }

  static fromPoint(point: Point): Vertex {
    const vertex = VertexOps.fromPointRaw(point);
    return new Vertex(vertex);
  }

  static fromPoint2D(point: Point2D): Vertex {
    return Vertex.fromPoint(new Point(point.x, point.y, 0));
  }

  compareTo(other: Vertex): boolean {
    if (!(other instanceof Vertex)) {
      return false;
    }

    return this.getShape().IsPartner(other.getShape());
  }

  serialize() {
    return {}
  }
}
