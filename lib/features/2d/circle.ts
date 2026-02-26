import { Geometry } from "../../oc/geometry.js";
import { SceneObject } from "../../common/scene-object.js";
import { PlaneObjectBase } from "../plane-renderable-base.js";
import { ExtrudableGeometryBase } from "./extrudable-base.js";

export type CircleOptions = {};

export class Circle extends ExtrudableGeometryBase {
  constructor(public radius: number, private options: CircleOptions = null, targetPlane: PlaneObjectBase = null) {
    super(targetPlane);
  }

  getType() {
    return 'circle';
  }

  build() {
    const plane = this.targetPlane?.getPlane() || this.sketch.getPlane();
    const center = this.targetPlane
      ? plane.worldToLocal(this.targetPlane.getPlaneCenter())
      : this.getCurrentPosition();

    console.log('Circle: building edges')

    const circle = Geometry.makeCircle(plane.localToWorld(center), this.radius, plane.normal);

    let edge = Geometry.makeEdgeFromCircle(circle);

    this.addShape(edge);
    if (this.sketch) this.setCurrentPosition(center);

    if (this.targetPlane) {
      this.targetPlane.removeShapes(this);
    }
  }

  override clone(): SceneObject[] {
    const targetPlane = this.targetPlane ? this.targetPlane.clone()[0] as PlaneObjectBase : null;
    const circle = new Circle(this.radius, this.options, targetPlane);
    return [circle];
  }

  compareTo(other: this): boolean {
    if (!(other instanceof Circle)) {
      return false;
    }

    if (this.targetPlane?.constructor !== other.targetPlane?.constructor) {
      return false;
    }

    if (this.targetPlane && other.targetPlane && !this.targetPlane.compareTo(other.targetPlane)) {
      return false;
    }

    return this.radius === other.radius
      && JSON.stringify(this.options) === JSON.stringify(other.options);
  }

  serialize() {
    return {
      radius: this.radius,
    }
  }

}
