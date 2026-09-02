import { SceneObject } from "../common/scene-object.js";
import { Scene } from "./scene.js";
import { SceneDisposal } from "./scene-disposal.js";
import { Sketch } from "../features/2d/sketch.js";
import type { Part } from "../features/part.js";

// State entries whose records reference the scene object that performed the
// action. On transfer they are pruned to actors that survived the compare —
// a discarded actor's records are stale, the rebuilt actor re-records them —
// and remapped to the new instances so scoped queries keep working.
const ACTOR_RECORD_KEYS: { key: string; actorField: string }[] = [
  { key: 'removedShapes', actorField: 'removedBy' },
  { key: 'addedFaces', actorField: 'addedBy' },
  { key: 'addedEdges', actorField: 'addedBy' },
  { key: 'modifiedFaces', actorField: 'modifiedBy' },
  { key: 'modifiedEdges', actorField: 'modifiedBy' },
  { key: 'removedFaces', actorField: 'removedBy' },
  { key: 'removedEdges', actorField: 'removedBy' },
];

export class SceneCompare {
  public static compare(oldScene: Scene, newScene: Scene): Scene {
    if (oldScene === newScene) {
      return newScene;
    }

    const map = new Map<SceneObject, SceneObject>();

    const objectCount = newScene.getSceneObjects().length;
    let i = 0;
    while (i < objectCount) {
      const newObj = newScene.getSceneObjectAt(i);
      const oldObj = oldScene.getSceneObjectAt(i);

      console.log('Checking:', newObj?.getUniqueType());

      if (!oldObj || oldObj.getUniqueType() !== newObj.getUniqueType() || !oldObj.compareTo(newObj)) {
        console.log('NO MATCH:', newObj.getUniqueType());
        break;
      }

      // Solved sketches match container-atomically: the solve couples every
      // child, so either the whole subtree (sketch + children) matches
      // structurally and is cached as one unit, or none of it is — a
      // sketch cached without its rebuilding children would never re-run
      // the solve those children read from.
      if (newObj instanceof Sketch && newObj.isSolvedMode()) {
        const newRun = SceneCompare.subtreeRun(newScene, i);
        const oldRun = SceneCompare.subtreeRun(oldScene, i);
        if (!SceneCompare.runsMatch(oldRun, newRun)) {
          console.log('NO MATCH (solved sketch subtree):', newObj.getUniqueType());
          break;
        }
        for (let j = 0; j < newRun.length; j++) {
          newScene.markCached(newRun[j]);
          map.set(oldRun[j], newRun[j]);
        }
        console.log('MATCHED (atomic):', newObj.getUniqueType());
        i += newRun.length;
        continue;
      }

      console.log('MATCHED:', oldObj.getUniqueType());

      newScene.markCached(newObj);
      map.set(oldObj, newObj);
      i++;
    }

    SceneCompare.dropPartiallyMatchedForeignParts(newScene, map);

    // Snapshot before the state rewrite below prunes cross-references out of
    // the transferred maps — the pruned records are exactly the resources
    // the disposal pass has to see as replaced.
    const oldSceneShapes = SceneDisposal.collectShapes(oldScene.getAllSceneObjects());

    // copy state from old to new
    for (const [oldObj, newObj] of map.entries()) {
      const oldState = oldObj.getFullState();

      for (const { key, actorField } of ACTOR_RECORD_KEYS) {
        SceneCompare.rewriteActorRecords(oldState, key, actorField, map);
      }

      newObj.restoreState(oldState);

      const staleId = newObj.id;
      newObj.inheritIdentityFrom(oldObj);
      newScene.reindexObject(newObj, staleId);

      const oldError = oldObj.getError();
      if (oldError) {
        newObj.setError(oldError);
      }
    }

    try {
      SceneDisposal.disposeReplaced(oldScene, newScene, map, oldSceneShapes);
    } catch (error) {
      console.error('Scene disposal after compare failed:', error);
    }

    return newScene;
  }

  /**
   * A foreign-unit part matches all or nothing, like a solved sketch: its
   * members are rescaled into the scene's unit as one unit after the last
   * of them builds, so a rebuilt member reading a cached (already scaled)
   * sibling would mix units. Membership is by enclosing part rather than a
   * contiguous run — a donor materialized mid-body interleaves with the
   * consumer's children — so this runs as a pass over the prefix match.
   */
  private static dropPartiallyMatchedForeignParts(
    newScene: Scene,
    map: Map<SceneObject, SceneObject>,
  ): void {
    const objects = newScene.getAllSceneObjects();
    const members = new Map<Part, SceneObject[]>();
    for (const obj of objects) {
      const part = newScene.findEnclosingPart(obj);
      if (!part || !part.isForeignUnit()) {
        continue;
      }
      let list = members.get(part);
      if (!list) {
        list = [];
        members.set(part, list);
      }
      list.push(obj);
    }

    for (const list of members.values()) {
      const cachedCount = list.filter(obj => newScene.isCached(obj)).length;
      if (cachedCount === 0 || cachedCount === list.length) {
        continue;
      }
      const dropped = new Set(list.filter(obj => newScene.isCached(obj)));
      for (const obj of dropped) {
        newScene.unmarkCached(obj);
      }
      for (const [oldObj, newObj] of map) {
        if (dropped.has(newObj)) {
          map.delete(oldObj);
        }
      }
    }
  }

  /** The container at `index` plus the contiguous run of its descendants. */
  private static subtreeRun(scene: Scene, index: number): SceneObject[] {
    const container = scene.getSceneObjectAt(index);
    const run: SceneObject[] = [container];
    const objects = scene.getSceneObjects();
    for (let i = index + 1; i < objects.length; i++) {
      if (!SceneCompare.isDescendantOf(objects[i], container)) {
        break;
      }
      run.push(objects[i]);
    }
    return run;
  }

  private static isDescendantOf(obj: SceneObject, ancestor: SceneObject): boolean {
    for (let parent = obj.getParent(); parent; parent = parent.getParent()) {
      if (parent === ancestor) {
        return true;
      }
    }
    return false;
  }

  private static runsMatch(oldRun: SceneObject[], newRun: SceneObject[]): boolean {
    if (oldRun.length !== newRun.length) {
      return false;
    }
    for (let i = 0; i < newRun.length; i++) {
      if (oldRun[i].getUniqueType() !== newRun[i].getUniqueType()
          || !oldRun[i].compareTo(newRun[i])) {
        return false;
      }
    }
    return true;
  }

  /**
   * Drop records whose actor did not survive the compare and point the
   * surviving records at the actors' new instances.
   */
  private static rewriteActorRecords(
    state: Map<string, any>,
    key: string,
    actorField: string,
    map: Map<SceneObject, SceneObject>,
  ): void {
    const records = state.get(key) as Record<string, any>[] | undefined;
    if (!records || records.length === 0) {
      return;
    }

    const rewritten: Record<string, any>[] = [];
    for (const record of records) {
      const matchedActor = map.get(record[actorField]);
      if (matchedActor) {
        rewritten.push({ ...record, [actorField]: matchedActor });
      }
    }

    state.set(key, rewritten);
  }
}
