import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Shape } from "../common/shape.js";
import { BooleanOps } from "../oc/boolean-ops.js";
import { ColorTransfer } from "../oc/color-transfer.js";

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
    const p = context.getProfiler();
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

    const fuseResult = p.record('Fuse solids', () => BooleanOps.fuse(allShapes));

    if (fuseResult.result.length === allShapes.length) {
      fuseResult.dispose();
      return;
    }

    if (!fuseResult.modifiedShapes.length) {
      fuseResult.dispose();
      return;
    }

    // Color rule for the user-facing Fuse op: the FIRST input is dominant.
    // If it has any colors, propagate those to the result (and bleed across
    // adjacent faces from any uncolored input). If the first input has no
    // colors, the fused result stays uncolored — even if other inputs are
    // colored, those colors are intentionally dropped.
    const firstShape = allShapes[0];
    if (firstShape && firstShape.hasColors()) {
      ColorTransfer.applyThroughMaker([firstShape], fuseResult.newShapes, fuseResult.maker);
      ColorTransfer.applyBleeding([firstShape], fuseResult.newShapes, fuseResult.maker);
    }

    for (const shape of fuseResult.modifiedShapes) {
      const obj = objShapeMap.get(shape);
      obj.removeShape(shape, this);
    }

    this.addShapes(fuseResult.newShapes);

    fuseResult.dispose();
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
