import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Axis } from "../math/axis.js";
import { Matrix4 } from "../math/matrix4.js";
import { rad } from "../helpers/math-helpers.js";
import { ShapeOps } from "../oc/shape-ops.js";
import { AxisObjectBase } from "./axis-renderable-base.js";
import { GeometrySceneObject } from "./2d/geometry.js";

export class Rotate2D extends GeometrySceneObject {

  constructor(
    public targetObjects: SceneObject[],
    public angle: number,
    private copy: boolean = false) {
    super();
  }

  build(context: BuildSceneObjectContext) {
    let objects: SceneObject[];
    let targetObjects = this.targetObjects;
    let axis: Axis;

    objects = this.sketch.getPreviousSiblings(this);

    if (this.targetObjects && this.targetObjects.length > 0) {
      targetObjects = objects.filter(obj => this.targetObjects.includes(obj));
    }
    else {
      targetObjects = objects;
    }

    const plane = this.sketch.getPlane();
    const currentPosition = plane.localToWorld(this.sketch.getPositionAt(this as any));
    axis = new Axis(currentPosition, plane.zAxis.direction);

    const matrix = Matrix4.fromRotationAroundAxis(axis.origin, axis.direction, rad(this.angle));

    for (const obj of targetObjects) {
      const shapes = obj.getShapes();
      for (const shape of shapes) {
        const transformed = ShapeOps.transform(shape, matrix);
        this.addShape(transformed);
        if (!this.copy) {
          obj.removeShape(shape, this);
        }
      }
    }

    const lastTangent = this.sketch.getTangentAt(this);
    if (lastTangent) {
      const transformedTangent = lastTangent.transform(matrix);
      this.setTangent(transformedTangent);
    }
  }

  compareTo(other: Rotate2D): boolean {
    if (!(other instanceof Rotate2D)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    if (this.copy !== other.copy) {
      return false;
    }

    if (this.angle !== other.angle) {
      return false;
    }

    const thisTargetObjects = this.targetObjects || [];
    const otherTargetObjects = other.targetObjects || [];

    if (thisTargetObjects.length !== otherTargetObjects.length) {
      return false;
    }

    for (let i = 0; i < thisTargetObjects.length; i++) {
      if (thisTargetObjects[i] !== otherTargetObjects[i]) {
        return false;
      }
    }

    return true;
  }

  getType(): string {
    return "rotate";
  }

  serialize() {
    return {
      angle: this.angle
    }
  }
}
