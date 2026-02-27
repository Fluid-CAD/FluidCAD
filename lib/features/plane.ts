import { SceneObject } from "../common/scene-object.js";
import { Plane } from "../math/plane.js";
import { PlaneRenderableOptions } from "../core/plane.js";
import { PlaneObjectBase } from "./plane-renderable-base.js";
import { FaceOps } from "../oc/face-ops.js";

export class PlaneObject extends PlaneObjectBase {

  constructor(public plane: Plane, public options?: PlaneRenderableOptions) {
    super();

    let p = this.plane;

    if (this.options) {
      p = p.transform(this.options);
    }

    this.setState('plane', p);
  }

  build() {
    let plane = this.getPlane();
    let center = this.getPlaneCenter();

    const transform = this.getTransform();
    if (transform) {
      plane = plane.applyMatrix(transform);
      this.setState('plane', plane);

      if (center) {
        center = center.transform(transform);
        this.setState('plane-center', center);
      }
    }

    const face = FaceOps.planeToFace(plane, center);
    face.markAsMetaShape();
    this.addShape(face);
  }

  override clone(): SceneObject[] {
    const planeRenderable = new PlaneObject(this.plane, this.options);
    return [planeRenderable];
  }

  isTransformable(): boolean {
      return true;
  }

  compareTo(other: PlaneObject): boolean {
    if (!(other instanceof PlaneObject)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    if (!this.plane.compareTo(other.plane)) {
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
      center: this.getPlaneCenter() || plane.origin,
      options: this.options,
    }
  }
}
