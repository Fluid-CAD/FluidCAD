import { Geometry } from "../../oc/geometry.js";
import { LazyVertex } from "../lazy-vertex.js";
import { PlaneObjectBase } from "../plane-renderable-base.js";
import { GeometrySceneObject } from "./geometry.js";

export class LineTo extends GeometrySceneObject {

  constructor(public end: LazyVertex, private targetPlane: PlaneObjectBase = null) {
    super();
  }

  build() {
    const plane = this.targetPlane?.getPlane() || this.sketch.getPlane();

    const targetPoint = this.end.asPoint2D();

    const currentPos = this.targetPlane
      ? plane.worldToLocal(this.targetPlane.getPlaneCenter())
      : this.getCurrentPosition();

    const start = plane.localToWorld(currentPos);
    const end = plane.localToWorld(targetPoint);

    let segment = Geometry.makeSegment(start, end);

    const edge = Geometry.makeEdge(segment);

    this.addShape(edge);

    this.setTangent(targetPoint.subtract(currentPos).normalize());
    if (this.sketch) this.setCurrentPosition(targetPoint);

    if (this.targetPlane) {
      this.targetPlane.removeShapes(this);
    }
  }

  compareTo(other: LineTo): boolean {
    if (!(other instanceof LineTo)) {
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

    return this.end.compareTo(other.end);
  }

  getType(): string {
    return 'line'
  }

  getUniqueType(): string {
    return 'line-two-points';
  }

  serialize() {
    return {
      end: this.end
    }
  }
}
