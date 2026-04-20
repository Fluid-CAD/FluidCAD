import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Shape } from "../common/shape.js";
import { BooleanOps } from "../oc/boolean-ops.js";
import { BooleanOps2 } from "../oc/boolean-ops2.js";

export class Bool extends SceneObject {
  private _sceneObjects: SceneObject[] = [];

  constructor(...objects: SceneObject[]) {
    super();
    this._sceneObjects = objects;
  }

  build(context: BuildSceneObjectContext) {
    let sceneObjects = this._sceneObjects;

    console.log("Building Bool with scene objects:", sceneObjects);
    if (sceneObjects?.length === 0) {
      sceneObjects = context.getSceneObjects();
    }

    const objShapeMap = new Map<Shape, SceneObject>();
    for (const obj of sceneObjects) {
      for (const shape of obj.getShapes({}, 'solid')) {
        objShapeMap.set(shape, obj);
        obj.removeShape(shape, this);
      }
    }

    const allShapes = Array.from(objShapeMap.keys());
    console.log("Fusing shapes:", allShapes);
    const result = BooleanOps2.fuse(allShapes);
    console.log("Boolean result:", result);

    for (const shape of result.addedFaces) {
      this.addShape(shape);
    }
  }

  compareTo(other: Bool): boolean {
    if (!(other instanceof Bool)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    if (this._sceneObjects.length !== other._sceneObjects.length) {
      return false;
    }

    for (let i = 0; i < this._sceneObjects.length; i++) {
      if (!this._sceneObjects[i].compareTo(other._sceneObjects[i])) {
        return false;
      }
    }

    return true;
  }

  getType(): string {
    return "bool";
  }

  serialize() {
    return {
    }
  }
}
