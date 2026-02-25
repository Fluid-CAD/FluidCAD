import { SceneObject } from "../common/scene-object.js";

export class Fuse extends SceneObject {
  constructor(private sceneObjects: SceneObject[]) {
    super();

  }

  build() {
    // const shapeObjectMap = new Map<Shape, SceneObject>();
    // for (const obj of this.sceneObjects) {
    //   const shapes = obj.getShapes();
    //   for (const shape of shapes) {
    //     shapeObjectMap.set(shape, obj);
    //   }
    // }
    //
    // const items = Array.from(shapeObjectMap.keys());
    // const { newShapes, modifiedShapes } = Extruder.fuseWithSceneObjects(items);
    // console.log("Final fused solids count:", newShapes.length);
    //
    // for (const shape of modifiedShapes) {
    //   const obj = shapeObjectMap.get(shape);
    //   obj.removeShape(shape, this);
    // }
    //
    // this.addShapes(newShapes);
  }

  compareTo(other: Fuse): boolean {
    if (!(other instanceof Fuse)) {
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
      objects: this.sceneObjects.map(s => s.serialize()),
    }
  }
}
