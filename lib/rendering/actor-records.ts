import type { SceneObject } from "../common/scene-object.js";

/**
 * The state entries whose records name the scene object that performed the
 * action (`removedBy`, `addedBy`, `setBy`, …). Scoped reads — the render
 * passes, rollback views, `getFaceColors(solid, scope)` — serve a record
 * only when its actor is in scope, so a record that survives a compare
 * has to name the actor's NEW instance: the old one is not in the next
 * render's scope, and the record would be silently filtered out.
 */
export class ActorRecords {
  static readonly KEYS: ReadonlyArray<{ key: string; actorField: string }> = [
    { key: 'removedShapes', actorField: 'removedBy' },
    { key: 'addedFaces', actorField: 'addedBy' },
    { key: 'addedEdges', actorField: 'addedBy' },
    { key: 'modifiedFaces', actorField: 'modifiedBy' },
    { key: 'modifiedEdges', actorField: 'modifiedBy' },
    { key: 'removedFaces', actorField: 'removedBy' },
    { key: 'removedEdges', actorField: 'removedBy' },
    { key: 'faceColors', actorField: 'setBy' },
  ];

  /**
   * Rewrite every actor-stamped record in `state` for a scene object that
   * survived a compare: records whose actor also survived point at the
   * actor's new instance (`map`: old → new), the rest are dropped — a
   * discarded actor's records are stale, and the rebuilt actor records
   * them again when it builds. Each record is copied, so its other flags
   * (`soft` on a display-only removal) travel with it.
   */
  static remap(state: Map<string, any>, map: Map<SceneObject, SceneObject>): void {
    for (const { key, actorField } of ActorRecords.KEYS) {
      ActorRecords.remapKey(state, key, actorField, map);
    }
  }

  private static remapKey(
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
