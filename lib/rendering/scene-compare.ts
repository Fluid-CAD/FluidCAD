import { SceneObject } from "../common/scene-object.js";
import { Scene } from "./scene.js";
import { SceneDisposal } from "./scene-disposal.js";

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
