import { SceneObject } from "../common/scene-object.js";
import { PlaneRenderableOptions } from "../core/plane.js";
import { PlaneObjectBase } from "./plane-renderable-base.js";
import { FaceOps } from "../oc/face-ops.js";
import { Point } from "../math/point.js";
import { Plane } from "../math/plane.js";

export class PlaneMiddleRenderable extends PlaneObjectBase {

  constructor(public p1: PlaneObjectBase, public p2: PlaneObjectBase, public options?: PlaneRenderableOptions) {
    super();
  }

  build() {
    const plane1 = this.p1.getPlane();
    const plane2 = this.p2.getPlane();

    const midpoint = plane1.origin.add(plane2.origin).multiplyScalar(0.5);

    const xDirection = plane1.xDirection;
    const normal = plane1.normal;

    const result = new Plane(midpoint, xDirection, normal);

    this.setState('plane', result);

    const face = FaceOps.planeToFace(result);
    this.addShape(face);
  }

  compareTo(other: PlaneMiddleRenderable): boolean {
    if (!(other instanceof PlaneMiddleRenderable)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    if (!this.p1.compareTo(other.p1)) {
      return false;
    }

    if (!this.p2.compareTo(other.p2)) {
      return false;
    }

    if (JSON.stringify(this.options) !== JSON.stringify(other.options)) {
      return false;
    }

    return true;
  }

  serialize() {
    const plane = this.getPlane()
    return {
      origin: plane.origin,
      xDirection: plane.xDirection,
      yDirection: plane.yDirection,
      normal: plane.normal,
      center: plane.origin,
      options: this.options,
    }
  }
}
