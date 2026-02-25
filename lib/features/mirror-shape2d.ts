import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Shape } from "../common/shape.js";
import { Sketch } from "./2d/sketch.js";
import { Axis } from "../math/axis.js";
import { Matrix4 } from "../math/matrix4.js";
import { ShapeOps } from "../oc/shape-ops.js";
import { GeometrySceneObject } from "./2d/geometry.js";
import { AxisObjectBase } from "./axis-renderable-base.js";

export class MirrorShape2D extends GeometrySceneObject {

  constructor(
    private axis: AxisObjectBase,
    private targetObjects: SceneObject[] = null) {
    super();
  }

  build(context: BuildSceneObjectContext) {
    let targetObjects = this.targetObjects;
    let sketch: Sketch  = this.sketch;
    let axis: Axis;
    const objects = sketch.getPreviousSiblings(this);

    if (this.targetObjects && this.targetObjects.length > 0) {
      targetObjects = objects.filter(obj => this.targetObjects.includes(obj));
    }
    else {
      targetObjects = objects;
    }

    this.axis.removeShapes(this)

    axis = this.axis.getAxis();

    const transformedShapes: Shape[] = [];

    for (const obj of targetObjects) {
      const shapes = obj.getShapes();
      for (const shape of shapes) {
        const matrix = Matrix4.mirrorAxis(axis.origin, axis.direction);
        const transformed = ShapeOps.transform(shape, matrix);
        transformedShapes.push(transformed);
      }
    }

    this.addShapes(transformedShapes);
  }

  compareTo(other: MirrorShape2D): boolean {
    if (!(other instanceof MirrorShape2D)) {
      return false;
    }

    if (!this.axis.compareTo(other.axis)) {
      return false;
    }

    const thisTargetObjects = this.targetObjects || [];
    const otherTargetObjects = other.targetObjects || [];

    if (thisTargetObjects.length !== otherTargetObjects.length) {
      return false;
    }

    for (let i = 0; i < thisTargetObjects.length; i++) {
      if (!thisTargetObjects[i].compareTo(otherTargetObjects[i])) {
        return false;
      }
    }

    return true;
  }

  getType(): string {
    return "mirror";
  }

  getUniqueType(): string {
    return 'mirror-shape-2d'
  }

  serialize() {
    return {
      axis: this.axis.serialize(),
    }
  }
}
