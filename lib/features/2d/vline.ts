import { Vertex } from "../../common/vertex.js";
import { Geometry } from "../../oc/geometry.js";
import { Point2D } from "../../math/point.js";
import { PlaneObjectBase } from "../plane-renderable-base.js";
import { GeometrySceneObject } from "./geometry.js";
import { IVLine } from "../../core/interfaces.js";

export class VerticalLine extends GeometrySceneObject implements IVLine {

  private _centered: boolean = false;

  constructor(public distance: number, private targetPlane: PlaneObjectBase = null) {
    super();
  }

  centered(value: boolean = true): this {
    this._centered = value;
    return this;
  }

  build() {
    const plane = this.targetPlane?.getPlane() || this.sketch.getPlane();

    const currentPos = this.targetPlane
      ? plane.worldToLocal(this.targetPlane.getPlaneCenter())
      : this.getCurrentPosition();
    const startPoint = this._centered
      ? currentPos.translate(0, -this.distance / 2)
      : currentPos;
    const endPoint = startPoint.translate(0, this.distance);

    const start = plane.localToWorld(startPoint);
    const end = plane.localToWorld(endPoint);

    let segment = Geometry.makeSegment(start, end);

    const edge = Geometry.makeEdge(segment);

    this.setState('start', Vertex.fromPoint2D(startPoint));
    this.setState('end', Vertex.fromPoint2D(endPoint));
    this.addShape(edge);

    const sign = Math.sign(this.distance) || 1;
    this.setTangent(new Point2D(0, sign));
    if (this.sketch) {
      this.setCurrentPosition(endPoint);
    }

    if (this.targetPlane) {
      this.targetPlane.removeShapes(this);
    }
  }

  compareTo(other: VerticalLine): boolean {
    if (!(other instanceof VerticalLine)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    if (this.targetPlane?.constructor !== other.targetPlane?.constructor) {
      return false;
    }
    if (this.targetPlane && other.targetPlane && !this.targetPlane.compareTo(other.targetPlane)) {
      return false;
    }

    return this.distance === other.distance && this._centered === other._centered;
  }

  getType(): string {
    return 'line'
  }

  getUniqueType(): string {
    return 'vline';
  }

  serialize() {
    return {
      distance: this.distance,
      centered: this._centered
    }
  }
}
