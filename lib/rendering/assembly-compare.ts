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

    // Tentative matches: a part whose OWN subtree compares equal.
    const matched = new Map<Part, Pair[]>();
    for (let i = 0; i < pairCount; i++) {
      const subtreePairs = collectSubtreePairs(newTopParts[i], oldTopParts[i]);
      if (subtreePairs) {
        matched.set(newTopParts[i], subtreePairs);
      }
    }

    // A part can consume geometry OWNED BY ANOTHER PART — an
    // `extrude(15, donor.features.sketch)` / `remove(donor.features.sketch)`
    // subtree looks unchanged when only the donor's sketch body changed
    // (leaf compareTo of a referenced source is shallow; the deep walk covers
    // the donor's subtree, not the consumer's). Drop the match whenever a
    // cross-part dependency's owner is rebuilding, iterated to a fixpoint so
    // a dropped part strands its own dependents too.
    let dropped = true;
    while (dropped) {
      dropped = false;
      for (const [part, pairs] of matched) {
        if (hasRebuildingCrossPartDependency(part, pairs, matched)) {
          matched.delete(part);
          dropped = true;
        }
      }
    }

    for (const newPart of newTopParts) {
      const pairs = matched.get(newPart);
      if (pairs) {
        console.log('Part MATCHED:', newPart.partName);
        for (const pair of pairs) {
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

// True when any object in the part's subtree depends on (or resolves against)
// geometry whose owning top-level part is a different part that is NOT
// matched — that owner rebuilds, so the consumer's cached state is stale.
function hasRebuildingCrossPartDependency(
  part: Part,
  pairs: Pair[],
  matched: Map<Part, Pair[]>,
): boolean {
  for (const pair of pairs) {
    const deps = [...pair.newObj.getDependencies(), ...pair.newObj.getBoundaryDependencies()];
    for (const dep of deps) {
      const owner = owningTopLevelPart(dep);
      if (owner && owner !== part && !matched.has(owner)) {
        return true;
      }
    }
  }
  return false;
}

function owningTopLevelPart(obj: SceneObject): Part | null {
  let current: SceneObject = obj;
  for (let parent = current.getParent(); parent; parent = current.getParent()) {
    current = parent;
  }
  return current instanceof Part ? current : null;
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
