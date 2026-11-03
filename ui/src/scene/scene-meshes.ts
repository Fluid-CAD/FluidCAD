import type { MeshCache, MeshPayload } from './mesh-cache';
import { SceneTimings } from './scene-timings';
import type { InboxOutcome } from './server-inbox';

/** A shape on the scene wire, as far as its mesh goes: whole (`meshKey`) or by reference (`meshRef`). */
type WireShape = Partial<MeshPayload> & { meshKey?: string; meshRef?: string };

/** What `POST /api/meshes` answers. */
export type MeshLookup = { meshes: Record<string, MeshPayload>; missing: string[] };

/** What a scene needs before it can be drawn. */
export type SceneMeshNeeds = {
  /** Every mesh key the scene names (whole or by reference): what is on screen once it is drawn. */
  keys: Set<string>;
  /** The references the page could not resolve from its cache. */
  missing: string[];
  /** How many shapes came by reference, and how many whole. */
  refs: number;
  whole: number;
};

/**
 * Puts a `scene-rendered` message's meshes in place before the page draws
 * it (generators S6b): every whole payload goes into the mesh cache (and the
 * shape takes the canonical arrays), and every `meshRef` is resolved from
 * it — the shape gets `meshes`, `vertices`, `faceVertices` and `meshKey`
 * back, exactly as a whole message would have carried them. So everything
 * downstream reads a scene as it always has.
 *
 * The rule: a scene is drawn whole or not at all. When a reference misses
 * the cache, the scene waits for {@link fetchMissing}; a key the server no
 * longer has belongs only to a scene a newer one replaced (the server keeps
 * its newest scene whole), so that scene is skipped and the newer one —
 * already sent — is drawn instead.
 */
export class SceneMeshes {
  /** The shape lists of a scene row that carry meshes (the server's `SceneMeshes.SHAPE_LISTS`). */
  static readonly SHAPE_LISTS = ['sceneShapes', 'hiddenShapes', 'referencedShapes'] as const;

  constructor(
    private readonly cache: MeshCache,
    private readonly lookup: (keys: string[]) => Promise<MeshLookup | null>,
  ) {}

  /**
   * Put a scene's meshes in place before it is drawn ({@link prepare}):
   * `'handle'` at once when the cache resolves every reference; after a
   * fetch of the rest otherwise — `'skip'` when even the server no longer
   * has one (a newer scene replaced it and is on its way). Timed into
   * {@link SceneTimings}.
   */
  ready(msg: { result?: unknown; sceneVersion?: unknown }): InboxOutcome | Promise<InboxOutcome> {
    const start = performance.now();
    const needs = this.prepare(msg);
    SceneTimings.prepared(msg, needs, performance.now() - start);
    if (needs.missing.length === 0) {
      return 'handle';
    }
    const keys = [...new Set(needs.missing)];
    const fetchStart = performance.now();
    return this.fetchMissing(msg, keys).then((resolved) => {
      SceneTimings.fetched(msg, keys.length, performance.now() - fetchStart);
      if (!resolved) {
        console.warn(`Scene v${msg.sceneVersion ?? '?'} skipped: the server no longer has meshes it referenced (a newer scene replaces it).`);
      }
      return resolved ? 'handle' : 'skip';
    });
  }

  /**
   * Keep every whole payload of `msg` — all of them first, so a reference
   * to a payload earlier in the same message resolves — then resolve every
   * reference the cache holds. Modifies the message's shapes in place.
   */
  prepare(msg: { result?: unknown }): SceneMeshNeeds {
    const shapes = SceneMeshes.shapesOf(msg);
    const keys = new Set<string>();
    let refs = 0;
    let whole = 0;
    for (const shape of shapes) {
      if (typeof shape.meshKey === 'string' && Array.isArray(shape.meshes)) {
        keys.add(shape.meshKey);
        whole++;
        SceneMeshes.assign(shape, this.cache.keep(shape.meshKey, SceneMeshes.payloadOf(shape)));
      }
    }
    for (const shape of shapes) {
      if (typeof shape.meshRef === 'string') {
        keys.add(shape.meshRef);
        refs++;
      }
    }
    return { keys, missing: this.resolve(shapes), refs, whole };
  }

  /**
   * Fetch the payloads `missing` names, keep them, and resolve the
   * message's remaining references. Answers whether every reference
   * resolved — false when the server no longer had one (or did not answer).
   */
  async fetchMissing(msg: { result?: unknown }, missing: string[]): Promise<boolean> {
    const answer = await this.lookup([...new Set(missing)]);
    if (!answer) {
      return false;
    }
    for (const [key, payload] of Object.entries(answer.meshes ?? {})) {
      if (payload && Array.isArray(payload.meshes)) {
        this.cache.keep(key, payload);
      }
    }
    return this.resolve(SceneMeshes.shapesOf(msg)).length === 0;
  }

  /** Every mesh key a (prepared) scene names: what is on screen once it is drawn. */
  static keysOf(msg: { result?: unknown }): Set<string> {
    const keys = new Set<string>();
    for (const shape of SceneMeshes.shapesOf(msg)) {
      const key = shape.meshKey ?? shape.meshRef;
      if (typeof key === 'string') {
        keys.add(key);
      }
    }
    return keys;
  }

  /** Every shape of every row's mesh-carrying lists. */
  static shapesOf(msg: { result?: unknown }): WireShape[] {
    const shapes: WireShape[] = [];
    if (!Array.isArray(msg.result)) {
      return shapes;
    }
    for (const row of msg.result as Record<string, unknown>[]) {
      for (const list of SceneMeshes.SHAPE_LISTS) {
        const listed = row?.[list];
        if (Array.isArray(listed)) {
          for (const shape of listed) {
            if (shape && typeof shape === 'object') {
              shapes.push(shape as WireShape);
            }
          }
        }
      }
    }
    return shapes;
  }

  /** Resolve every reference the cache holds; answer the keys of the rest. */
  private resolve(shapes: WireShape[]): string[] {
    const missing: string[] = [];
    for (const shape of shapes) {
      const key = shape.meshRef;
      if (typeof key !== 'string') {
        continue;
      }
      const payload = this.cache.take(key);
      if (!payload) {
        missing.push(key);
        continue;
      }
      delete shape.meshRef;
      shape.meshKey = key;
      SceneMeshes.assign(shape, payload);
    }
    return missing;
  }

  private static payloadOf(shape: WireShape): MeshPayload {
    const payload: MeshPayload = { meshes: shape.meshes! };
    if (shape.vertices !== undefined) {
      payload.vertices = shape.vertices;
    }
    if (shape.faceVertices !== undefined) {
      payload.faceVertices = shape.faceVertices;
    }
    return payload;
  }

  /** Give `shape` the payload's arrays — the canonical ones for its key. */
  private static assign(shape: WireShape, payload: MeshPayload): void {
    shape.meshes = payload.meshes;
    if (payload.vertices !== undefined) {
      shape.vertices = payload.vertices;
    }
    if (payload.faceVertices !== undefined) {
      shape.faceVertices = payload.faceVertices;
    }
  }
}
