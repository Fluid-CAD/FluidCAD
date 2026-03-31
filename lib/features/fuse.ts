import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Shape } from "../common/shape.js";
import { BooleanOps } from "../oc/boolean-ops.js";
import { ShapeOps } from "../oc/shape-ops.js";

export class Fuse extends SceneObject {
  private _sceneObjects: SceneObject[] = [];

  constructor(...objects: SceneObject[]) {
    super();
    this._sceneObjects = objects;
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
      for (const shape of obj.getShapes({}, 'solid')) {
        objShapeMap.set(shape, obj);
      }
    }

    const allShapes = Array.from(objShapeMap.keys());
    if (allShapes.length < 2) {
      return;
    }

    const fuseResult = BooleanOps.fuse(allShapes);

    if (fuseResult.result.length === allShapes.length) {
      return;
    }

    if (!fuseResult.modifiedShapes.length) {
      return;
    }

    for (const shape of fuseResult.modifiedShapes) {
      const obj = objShapeMap.get(shape);
      obj.removeShape(shape, this);
    }

    this.addShapes(fuseResult.newShapes);
  }

  compareTo(other: Fuse): boolean {
    if (!(other instanceof Fuse)) {
      return false;
    }

    if (!super.compareTo(other)) {
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
    return "fuse";
  }

  serialize() {
    return {
    }
  }
}
