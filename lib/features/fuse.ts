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

    const args = allShapes.slice(0, 1);
    const tools = allShapes.slice(1);

    const fuseResult = BooleanOps.fuseMultiShape(args, tools, allShapes);

    if (fuseResult.solids.length === allShapes.length) {
      return;
    }

    if (!fuseResult.modifiedShapes.length) {
      return;
    }

    const newShapes: Shape[] = [];
    for (const solid of fuseResult.solids) {
      const existsInOriginal = allShapes.some(s => s.getShape().IsPartner(solid.getShape()));
      if (!existsInOriginal) {
        newShapes.push(ShapeOps.cleanShape(solid));
      }
    }

    for (const shape of fuseResult.modifiedShapes) {
      const obj = objShapeMap.get(shape);
      obj.removeShape(shape, this);
    }

    this.addShapes(newShapes);
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
