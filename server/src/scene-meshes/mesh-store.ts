import { SceneMeshes, type MeshPayload, type SceneMeshEntry } from './scene-meshes.ts';

/** One broadcast scene's payloads by key. */
type StoredScene = { payloads: Map<string, MeshPayload>; weight: number };

/** What `POST /api/meshes` answers. */
export type MeshLookup = { meshes: Record<string, MeshPayload>; missing: string[] };

/**
 * The payloads of the scenes most recently broadcast, by mesh key: what
 * `POST /api/meshes` answers a page that was sent a `meshRef` it no longer
 * holds (S6b).
 *
 * The rule: **the newest scene is always kept whole**, and older scenes
 * while they fit {@link MAX_OLDER_WEIGHT} and {@link MAX_SCENES}. So a key
 * of the newest scene is never missing, and a key that is missing belongs
 * only to a scene some newer one has replaced — which the asking page has
 * been sent, or is being sent, and will draw instead. It holds plain arrays
 * the scene messages already carry (the newest scene's are the session's
 * own), never a kernel object.
 */
export class MeshStore {
  /** How many numbers' worth of older scenes are kept beside the newest. */
  static readonly MAX_OLDER_WEIGHT = 4_000_000;
  /** How many scenes are kept at most, the newest included. */
  static readonly MAX_SCENES = 4;
  /** The most keys one lookup may ask for. */
  static readonly MAX_LOOKUP = 20_000;

  /** Newest first. */
  private scenes: StoredScene[] = [];

  /** A scene went to the pages: its payloads become the newest. */
  noteScene(entries: readonly SceneMeshEntry[]): void {
    const payloads = new Map<string, MeshPayload>();
    let weight = 0;
    for (const entry of entries) {
      if (!payloads.has(entry.key)) {
        payloads.set(entry.key, SceneMeshes.payloadOf(entry.shape));
        weight += entry.weight;
      }
    }
    const kept: StoredScene[] = [{ payloads, weight }];
    let older = 0;
    for (const scene of this.scenes) {
      if (kept.length >= MeshStore.MAX_SCENES || older + scene.weight > MeshStore.MAX_OLDER_WEIGHT) {
        break;
      }
      kept.push(scene);
      older += scene.weight;
    }
    this.scenes = kept;
  }

  /** The payloads of `keys` the kept scenes hold (newest first), and the keys none does. */
  lookup(keys: readonly string[]): MeshLookup {
    const meshes: Record<string, MeshPayload> = {};
    const missing: string[] = [];
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(meshes, key)) {
        continue;
      }
      const payload = this.find(key);
      if (payload) {
        meshes[key] = payload;
      } else {
        missing.push(key);
      }
    }
    return { meshes, missing };
  }

  /** How many scenes and payloads are kept (tests, diagnostics). */
  stats(): { scenes: number; keys: number; weight: number } {
    let keys = 0;
    let weight = 0;
    for (const scene of this.scenes) {
      keys += scene.payloads.size;
      weight += scene.weight;
    }
    return { scenes: this.scenes.length, keys, weight };
  }

  private find(key: string): MeshPayload | undefined {
    for (const scene of this.scenes) {
      const payload = scene.payloads.get(key);
      if (payload) {
        return payload;
      }
    }
    return undefined;
  }
}
