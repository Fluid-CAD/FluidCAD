import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Matrix4 } from "../math/matrix4.js";
import { ShapeOps } from "../oc/shape-ops.js";
import { LazyVertex } from "./lazy-vertex.js";

export class Translate extends SceneObject {

  constructor(private targetObjects: SceneObject[], private amount: LazyVertex, private copy: boolean = false) {
    super();
  }

  build(context: BuildSceneObjectContext) {
    const objects = this.targetObjects || context.getSceneObjects()

    for (const obj of objects) {
      const shapes = obj.getShapes();
      for (const shape of shapes) {
        if (!shape.isSolid()) {
          continue;
        }

        const amount = this.amount.asPoint();

        let transformed = ShapeOps.transform(shape, Matrix4.fromTranslation(amount.x, amount.y, amount.z));
        this.addShape(transformed);
        if (!this.copy) {
          obj.removeShape(shape, this)
        }
      }
    }
  }

  clone(): SceneObject[] {
    const targetObjects = this.targetObjects.map(obj => obj.clone()).flat();
    const translate = new Translate(targetObjects, this.amount, this.copy);
    return [translate];
  }

  compareTo(other: Translate): boolean {
    if (!(other instanceof Translate)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    if (!this.amount.compareTo(other.amount)) {
      return false;
    }

    if (this.copy !== other.copy) {
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
    return "translate";
  }

  serialize() {
    return {
      amount: this.amount
    }
  }
}
