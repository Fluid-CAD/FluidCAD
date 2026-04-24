import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Matrix4 } from "../math/matrix4.js";
import { ShapeOps } from "../oc/shape-ops.js";
import { LazyVertex } from "./lazy-vertex.js";

export class Translate extends SceneObject {
  private _targetObjects: SceneObject[] | null = null;

  constructor(private amount: LazyVertex, private copy: boolean = false, ...targets: SceneObject[]) {
    super();
    this._targetObjects = targets.length > 0 ? targets : null;
  }

  get targetObjects(): SceneObject[] {
    return this._targetObjects;
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

        const matrix = Matrix4.fromTranslation(amount.x, amount.y, amount.z);
        const transformed = ShapeOps.transform(shape, matrix);
        transformed.setMeshSource(shape, matrix);
        this.addShape(transformed);
        if (!this.copy) {
          obj.removeShape(shape, this)
        }
      }
    }
  }

  override getDependencies(): SceneObject[] {
    return this.targetObjects ? [...this.targetObjects] : [];
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const targets = this.targetObjects
      ? this.targetObjects.map(obj => remap.get(obj) || obj)
      : [];
    return new Translate(this.amount, this.copy, ...targets);
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
