import { Geometry } from "../../oc/geometry.js";
import { SceneObject } from "../../common/scene-object.js";
import { PlaneObjectBase } from "../plane-renderable-base.js";
import { ExtrudableGeometryBase } from "./extrudable-base.js";

export type CircleOptions = {};

export class Circle extends ExtrudableGeometryBase {
  constructor(public diameter: number, private options: CircleOptions = null, targetPlane: PlaneObjectBase = null) {
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

    const radius = this.diameter / 2;
    const circle = Geometry.makeCircle(plane.localToWorld(center), radius, plane.normal);

    let edge = Geometry.makeEdgeFromCircle(circle);

    this.addShape(edge);
    if (this.sketch) {
      this.setCurrentPosition(center);
    }

    if (this.targetPlane) {
      this.targetPlane.removeShapes(this);
    }
  }

  override getDependencies(): SceneObject[] {
    return this.targetPlane ? [this.targetPlane] : [];
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const targetPlane = this.targetPlane ? (remap.get(this.targetPlane) as PlaneObjectBase || this.targetPlane) : null;
    return new Circle(this.diameter, this.options, targetPlane);
  }

  compareTo(other: this): boolean {
    if (!(other instanceof Circle)) {
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

    return this.diameter === other.diameter
      && JSON.stringify(this.options) === JSON.stringify(other.options);
  }

  serialize() {
    return {
      diameter: this.diameter,
    }
  }

}
