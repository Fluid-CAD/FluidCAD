import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Shape } from "../common/shape.js";
import { BooleanOps } from "../oc/boolean-ops.js";
import { ShapeOps } from "../oc/shape-ops.js";

export class Common extends SceneObject {
  private _sceneObjects: SceneObject[] = [];
  private _keepOriginal: boolean = false;

  constructor(...objects: SceneObject[]) {
    super();
    this._sceneObjects = objects;
  }

  keepOriginal(value: boolean = true): this {
    this._keepOriginal = value;
    return this;
  }

  get sceneObjects(): SceneObject[] {
    return this._sceneObjects;
  }

  build(context: BuildSceneObjectContext) {
    let sceneObjects = this.sceneObjects;

    if (sceneObjects?.length === 0) {
      sceneObjects = context.getSceneObjects();
    }

    const objShapeMap = new Map<Shape, SceneObject>();
    for (const obj of sceneObjects) {
      for (const shape of obj.getShapes({ excludeMeta: false }, 'solid')) {
        objShapeMap.set(shape, obj);
      }
    }

    const allShapes = Array.from(objShapeMap.keys());
    if (allShapes.length < 2) {
      return;
    }

    const { newShapes, modifiedShapes, result } = BooleanOps.common(allShapes);

    if (!modifiedShapes.length && newShapes.length === 0) {
      return;
    }

    if (!this._keepOriginal) {
      for (const shape of allShapes) {
        const obj = objShapeMap.get(shape);
        obj.removeShape(shape, this);
      }
    }

    this.addShapes(newShapes.length > 0 ? newShapes : result);
  }

  compareTo(other: Common): boolean {
    if (!(other instanceof Common)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    if (this._keepOriginal !== other._keepOriginal) {
      return false;
    }

    if (this.sceneObjects.length !== other.sceneObjects.length) {
      return false;
    }

    for (let i = 0; i < this.sceneObjects.length; i++) {
      if (!this.sceneObjects[i].compareTo(other.sceneObjects[i])) {
        return false;
      }
    }

    return true;
  }

  getType(): string {
    return "common";
  }

  serialize() {
    return {
    }
  }
}
