import { Scene } from "../rendering/scene.js";
import { AssemblyScene } from "../rendering/assembly-scene.js";
import { SceneObject } from "../common/scene-object.js";
import { Shape } from "../common/shape.js";

/** A shape the scene currently renders, with the leaf object that owns it. */
export type RenderedCandidate = { object: SceneObject; shape: Shape };

/** Why a pool could not be narrowed the way the caller asked. */
export type RenderedPoolRefusalCode = 'unknown-shape' | 'unknown-instance' | 'not-an-assembly';

export type RenderedPoolRefusal = { kind: 'refused'; code: RenderedPoolRefusalCode; reason: string };

export type RenderedPoolSelection =
  | { kind: 'ok'; candidates: RenderedCandidate[] }
  | RenderedPoolRefusal;

/**
 * The pool of shapes the inspection checks (`validate`, `interfere`) run
 * over: what the scene renders, addressed the way the other inspection
 * paths address geometry.
 *
 * "What the scene renders" is read from the scene's rendered objects: a
 * visible leaf object's `sceneShapes`, so a solid a later cut consumed, a
 * feature hidden by a rollback, or an exposure's soft-removed source is not
 * in the pool — the agent asked about the geometry it can see.
 */
export class RenderedSolidPool {

  /**
   * Every shape a visible leaf object currently renders, in scene order.
   * The rendered record carries shape ids (its `object` is the serialized
   * form); the live wrappers come from the scene object itself.
   */
  static renderedCandidates(scene: Scene): RenderedCandidate[] {
    const out: RenderedCandidate[] = [];
    for (const object of scene.getAllSceneObjects()) {
      if (object.isContainer()) {
        continue;
      }
      const rendered = scene.getRenderedObject(object);
      if (!rendered || !rendered.visible || rendered.sceneShapes.length === 0) {
        continue;
      }
      const renderedIds = new Set(rendered.sceneShapes.map(s => s.shapeId));
      for (const shape of object.getOwnShapes({ excludeMeta: false, excludeGuide: false })) {
        if (renderedIds.has(shape.id)) {
          out.push({ object, shape });
        }
      }
    }
    return out;
  }

  /** Part id → instance ids, or null when the scene is not an assembly. */
  static instancesByPartId(scene: Scene): Map<string, string[]> | null {
    if (!(scene instanceof AssemblyScene)) {
      return null;
    }
    const map = new Map<string, string[]>();
    for (const instance of scene.getSerializedInstances()) {
      const list = map.get(instance.partId) ?? [];
      list.push(instance.instanceId);
      map.set(instance.partId, list);
    }
    return map;
  }

  /**
   * The default pool: solids only (sketch geometry and helper shapes are
   * never solids), no meta or guide shape, and in an assembly only
   * prototypes at least one instance shows.
   */
  static isRenderedSolid(scene: Scene, candidate: RenderedCandidate, instances: Map<string, string[]> | null): boolean {
    const shape = candidate.shape;
    if (shape.getType() !== 'solid' || shape.isMetaShape() || shape.isGuideShape()) {
      return false;
    }
    if (!instances) {
      return true;
    }
    const part = scene.findEnclosingPart(candidate.object);
    return part !== null && (instances.get(part.id)?.length ?? 0) > 0;
  }

  /** Every rendered solid of the default pool, in scene order. */
  static renderedSolids(scene: Scene): RenderedCandidate[] {
    const instances = RenderedSolidPool.instancesByPartId(scene);
    return RenderedSolidPool.renderedCandidates(scene).filter(c => RenderedSolidPool.isRenderedSolid(scene, c, instances));
  }

  /** The candidates belonging to one assembly instance's part prototype. */
  static scopeToInstance(scene: Scene, candidates: RenderedCandidate[], instanceId: string): RenderedPoolSelection {
    if (!(scene instanceof AssemblyScene)) {
      return { kind: 'refused', code: 'not-an-assembly', reason: `instanceId "${instanceId}" needs an assembly file; this scene is a part.` };
    }
    const instance = scene.getInstance(instanceId);
    if (!instance) {
      return { kind: 'refused', code: 'unknown-instance', reason: RenderedSolidPool.unknownInstanceReason(instanceId) };
    }
    const members = new Set(scene.getPartScopedAllObjects(instance.part));
    return { kind: 'ok', candidates: candidates.filter(c => members.has(c.object)) };
  }

  /** The candidates with these shape ids, deduplicated, in the order asked; any unknown id refuses. */
  static pickShapes(candidates: RenderedCandidate[], shapeIds: string[]): RenderedPoolSelection {
    const byId = new Map(candidates.map(c => [c.shape.id, c]));
    const missing = shapeIds.filter(id => !byId.has(id));
    if (missing.length > 0) {
      return {
        kind: 'refused',
        code: 'unknown-shape',
        reason: `No rendered shape ${missing.map(id => `"${id}"`).join(', ')} in the scene (shape ids come from list_shapes or get_scene_summary).`,
      };
    }
    const unique = [...new Set(shapeIds)];
    return { kind: 'ok', candidates: unique.map(id => byId.get(id)!) };
  }

  static unknownInstanceReason(instanceId: string): string {
    return `No instance "${instanceId}" in the assembly (instance ids come from get_scene_summary).`;
  }
}
