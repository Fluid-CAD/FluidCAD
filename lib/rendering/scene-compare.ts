import { Shape } from "../common/shape.js";
import { SceneObject } from "../common/scene-object.js";
import { Scene } from "./scene.js";

export class SceneCompare {
  public static compare(oldScene: Scene, newScene: Scene): Scene {

    const map = new Map<SceneObject, SceneObject>();

    for (const obj of newScene) {
      const index = newScene.indexOf(obj);

      console.log('Checking object:', obj?.getUniqueType());

      let oldMatch: SceneObject = null;
      const oldObj = oldScene.getSceneObjectAt(index);

      if (oldObj && oldObj.getUniqueType() === obj.getUniqueType()) {
        console.log('Comparing', oldObj.getUniqueType(), 'to', obj.getUniqueType());
        if (oldObj.compareTo(obj)) {
          console.log('MATCHED:', oldObj.getUniqueType());
          oldMatch = oldObj;

          newScene.markCached(obj);
          map.set(oldMatch, obj);
        }
        else {
          break;
        }
      }
      else {
        console.log('NO MATCH:', obj.getUniqueType());
      }
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
