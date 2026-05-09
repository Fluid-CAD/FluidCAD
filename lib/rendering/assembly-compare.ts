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

    // State is cloned per new SceneObject; aliasing the old Map propagates
    // mutations (e.g. `clean()` pushing into removedShapes) across the
    // transitive sharing chains that build up over sequential renders.
    //
    // Identity is intentionally not inherited: the assembly-controller's
    // partId-equality fast path would preserve the existing partMesh,
    // which falls out of sync with the solver's connector frames when a
    // Part flips between matched and unmatched across sequential param
    // changes — bodies drift in z and laterally. Skipping inheritance
    // forces the controller's slow path every render; build(), .brep
    // import, and triangulation are still cached.
    for (const [oldObj, newObj] of map.entries()) {
      const oldState = oldObj.getFullState();
      const newState = cloneState(oldState);

      const oldRemovedShapes = newState.get('removedShapes') as { shape: Shape; removedBy: SceneObject }[];
      const newRemovedShapes: { shape: Shape; removedBy: SceneObject }[] = [];
      for (const r of oldRemovedShapes) {
        const removedByNewObj = map.get(r.removedBy);
        if (removedByNewObj) {
          newRemovedShapes.push({ shape: r.shape, removedBy: removedByNewObj });
        }
      }
      newState.set('removedShapes', newRemovedShapes);

      newObj.restoreState(newState);

      const oldError = oldObj.getError();
      if (oldError) {
        newObj.setError(oldError);
      }
    }

    return newScene;
  }
}

function cloneState(state: Map<string, any>): Map<string, any> {
  const out = new Map<string, any>();
  for (const [key, value] of state) {
    if (Array.isArray(value)) {
      out.set(key, value.slice());
    } else {
      out.set(key, value);
    }
  }
  return out;
}

function topLevelParts(scene: AssemblyScene): Part[] {
  return scene.getAllSceneObjects().filter(
    obj => obj instanceof Part && obj.getParent() === null,
  ) as Part[];
}

// Returns pairs only on complete subtree match — partial matches are
// discarded so a single divergence leaves the whole Part for full rebuild.
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
