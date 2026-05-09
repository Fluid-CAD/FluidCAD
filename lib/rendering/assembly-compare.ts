import { SceneObject } from "../common/scene-object.js";
import { Shape } from "../common/shape.js";
import { AssemblyScene } from "./assembly-scene.js";
import { Part } from "../features/part.js";

type Pair = { newObj: SceneObject; oldObj: SceneObject };

export class AssemblyCompare {
  static compare(oldScene: AssemblyScene, newScene: AssemblyScene): AssemblyScene {
    const map = new Map<SceneObject, SceneObject>();

    const newTopParts = topLevelParts(newScene);
    const oldTopParts = topLevelParts(oldScene);

    const pairCount = Math.min(newTopParts.length, oldTopParts.length);

    for (let i = 0; i < pairCount; i++) {
      const newPart = newTopParts[i];
      const oldPart = oldTopParts[i];

      const subtreePairs = collectSubtreePairs(newPart, oldPart);
      if (subtreePairs) {
        console.log('Part MATCHED:', newPart.partName);
        for (const pair of subtreePairs) {
          map.set(pair.oldObj, pair.newObj);
          newScene.markCached(pair.newObj);
        }
      } else {
        console.log('Part NO MATCH:', newPart.partName);
      }
    }

    // Second pass: restore state and inherit identity. Done after the full
    // old→new map is built so removedShapes.removedBy can be remapped from
    // old SceneObject refs to their new counterparts.
    for (const [oldObj, newObj] of map.entries()) {
      const oldState = oldObj.getFullState();
      const oldRemovedShapes = oldState.get('removedShapes') as { shape: Shape; removedBy: SceneObject }[];

      const newRemovedShapes: { shape: Shape; removedBy: SceneObject }[] = [];
      for (const r of oldRemovedShapes) {
        const removedByNewObj = map.get(r.removedBy);
        if (removedByNewObj) {
          newRemovedShapes.push({ shape: r.shape, removedBy: removedByNewObj });
        }
      }
      oldState.set('removedShapes', newRemovedShapes);

      newObj.restoreState(oldState);

      const staleId = newObj.id;
      newObj.inheritIdentityFrom(oldObj);
      newScene.reindexObject(newObj, staleId);

      const oldError = oldObj.getError();
      if (oldError) {
        newObj.setError(oldError);
      }
    }

    return newScene;
  }
}

function topLevelParts(scene: AssemblyScene): Part[] {
  return scene.getAllSceneObjects().filter(
    obj => obj instanceof Part && obj.getParent() === null,
  ) as Part[];
}

// Walk the new and old subtrees in lockstep, comparing each paired
// SceneObject via the existing compareTo() chain. Returns the full list of
// (new, old) pairs only on complete subtree match — partial matches are
// discarded so a single divergence anywhere in the subtree leaves the whole
// Part for full rebuild.
function collectSubtreePairs(newObj: SceneObject, oldObj: SceneObject): Pair[] | null {
  if (newObj.getUniqueType() !== oldObj.getUniqueType()) {
    return null;
  }
  if (!oldObj.compareTo(newObj)) {
    return null;
  }

  const newChildren = newObj.getChildren();
  const oldChildren = oldObj.getChildren();
  if (newChildren.length !== oldChildren.length) {
    return null;
  }

  const pairs: Pair[] = [{ newObj, oldObj }];
  for (let i = 0; i < newChildren.length; i++) {
    const childPairs = collectSubtreePairs(newChildren[i], oldChildren[i]);
    if (!childPairs) {
      return null;
    }
    pairs.push(...childPairs);
  }

  return pairs;
}
