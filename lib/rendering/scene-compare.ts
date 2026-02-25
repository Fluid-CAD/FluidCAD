import { Shape } from "../common/shape.js";
import { SceneObject } from "../common/scene-object.js";
import { Scene } from "./scene.js";

export class SceneCompare {
  public static compare(oldScene: Scene, newScene: Scene): Scene {

    const map = new Map<SceneObject, SceneObject>();

    for (let i = 0; i < newScene.getSceneObjects().length; i++) {
      const newObj = newScene.getSceneObjectAt(i);
      const oldObj = oldScene.getSceneObjectAt(i);

      console.log('Checking:', newObj?.getUniqueType());

      let oldMatch: SceneObject = null;

      if (!oldObj || oldObj.getUniqueType() !== newObj.getUniqueType() || !oldObj.compareTo(newObj)) {
        console.log('NO MATCH:', newObj.getUniqueType());
        break;
      }

      console.log('MATCHED:', oldObj.getUniqueType());
      oldMatch = oldObj;

      newScene.markCached(newObj);
      map.set(oldMatch, newObj);
    }

    // copy state from old to new
    for (const [oldObj, newObj] of map.entries()) {
      const oldSttate = oldObj.getFullState();
      const oldRemovedShapes = oldSttate.get('removedShapes') as { shape: Shape, removedBy: SceneObject }[];

      const newRemovedShapes = [];

      for (const r of oldRemovedShapes) {
        const removedByNewObj = map.get(r.removedBy);
        if (removedByNewObj) {
          newRemovedShapes.push({
            shape: r.shape,
            removedBy: removedByNewObj,
          });
        }
      }

      oldSttate.set('removedShapes', newRemovedShapes);

      newObj.restoreState(oldSttate);
    }

    return newScene;
  }
}
