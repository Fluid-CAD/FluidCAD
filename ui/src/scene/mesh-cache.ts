import type { BufferGeometry, Object3D } from 'three';
import type { SceneObjectMesh } from '../types';

/** One shape's mesh payload: what a mesh key names. */
export type MeshPayload = {
  meshes: SceneObjectMesh[];
  vertices?: number[];
  faceVertices?: number[][];
};

/** One key's payload and the geometry built from it. */
type MeshEntry = {
  key: string;
  payload: MeshPayload;
  weight: number;
  /** Built from the payload's meshes, one per mesh, on first use — shared by every object that draws it. */
  geometries: Map<SceneObjectMesh, BufferGeometry>;
};

export type MeshCacheStats = { entries: number; weight: number; capacity: number; geometries: number; evicted: number };

/**
 * The page's meshes by key (generators S6b, P5/P6): the payloads scenes
 * brought — `meshes`, `vertices`, `faceVertices`, named by the engine's
 * `meshKey` — and the three.js geometry built from them.
 *
 * **Payloads.** The first payload kept under a key is the key's canonical
 * one: a later scene's shape with the same key — sent whole or as a
 * `meshRef` — is given the canonical arrays, so every scene, and every
 * consumer reading `shape.meshes`, sees the same objects for the same key.
 *
 * **Geometry (P6).** {@link geometryOf} builds a canonical mesh's geometry
 * once and hands the same geometry to every object that draws it: every
 * instance of an assembly template, every render that keeps the shape (a
 * part re-rendered, a theme rebuild). A geometry the cache shares ignores
 * `dispose()` — any code freeing a mesh tree may keep calling it — and is
 * freed by the cache alone, when its key is evicted. A mesh that is not a
 * canonical one (a dialog's ghost, a thumbnail) gets geometry of its own, as
 * before.
 *
 * **Bounds.** Weighed like the server weighs it ({@link weightOf}, a count
 * of numbers), least recently used first, past {@link capacity}: on
 * {@link trim}, entries go oldest first until the weight is back under
 * {@link TRIM_TO} of it — never one the scene on screen names
 * ({@link setOnScreen}), and never one whose geometry an object under a
 * watched root still draws ({@link watch}): the geometry is disposed only
 * when nothing can draw it. The page announces its capacity in its hello;
 * the server counts on half of it (see the server's `MeshLedger`), and asks
 * nothing about evictions: a key the page no longer holds is fetched
 * (`POST /api/meshes`) before the scene that needs it is drawn.
 */
export class MeshCache {
  /** How many numbers' worth of meshes the page keeps beyond what is on screen. */
  static readonly DEFAULT_CAPACITY = 4_000_000;
  /** A trim brings the weight down to this share of the capacity, so it runs once per many scenes, not every one. */
  static readonly TRIM_TO = 0.9;

  /** key → entry, least recently used first. */
  private readonly entries = new Map<string, MeshEntry>();
  /** Which entry a canonical mesh belongs to. */
  private readonly owners = new WeakMap<SceneObjectMesh, MeshEntry>();
  /** The real `dispose` of every geometry the cache shares. */
  private readonly disposers = new WeakMap<BufferGeometry, () => void>();
  /** Held weakly: watching a tree never keeps it alive. */
  private readonly roots = new Set<WeakRef<Object3D>>();
  private onScreen: ReadonlySet<string> = new Set();
  private weight = 0;
  private evicted = 0;

  /** `localStorage[OFF_FLAG] = '0'` turns the cache off: whole scenes, geometry per object, as before S6b. */
  static readonly OFF_FLAG = 'fluidcad.meshCache';

  constructor(readonly capacity: number = MeshCache.DEFAULT_CAPACITY) {}

  /**
   * Whether the page keeps a mesh cache — announces it in its hello and
   * puts scenes' payloads in it. On unless {@link OFF_FLAG} says `'0'` (a
   * switch for measuring against, or for ruling the cache out).
   */
  static enabled(): boolean {
    try {
      return globalThis.localStorage?.getItem(MeshCache.OFF_FLAG) !== '0';
    } catch {
      return true;
    }
  }

  /**
   * How many numbers a payload carries — every mesh's vertices, normals,
   * indices, face mapping and face sides, plus the topology vertices and
   * face-vertex lists: the server's `SceneMeshes.weightOf`, number for
   * number, so both ends bound the same thing.
   */
  static weightOf(payload: MeshPayload): number {
    let weight = 0;
    for (const mesh of payload.meshes) {
      weight += mesh.vertices?.length ?? 0;
      weight += mesh.normals?.length ?? 0;
      weight += mesh.indices?.length ?? 0;
      weight += mesh.faceMapping?.length ?? 0;
      weight += mesh.faceSides?.length ?? 0;
    }
    weight += payload.vertices?.length ?? 0;
    for (const face of payload.faceVertices ?? []) {
      weight += face.length;
    }
    return weight;
  }

  /**
   * Keep `payload` under `key` — unless the key is held already: then the
   * payload held is the canonical one. Either way the key is the most
   * recently used, and the canonical payload is answered.
   */
  keep(key: string, payload: MeshPayload): MeshPayload {
    const held = this.touch(key);
    if (held) {
      return held.payload;
    }
    const entry: MeshEntry = { key, payload, weight: MeshCache.weightOf(payload), geometries: new Map() };
    this.entries.set(key, entry);
    this.weight += entry.weight;
    for (const mesh of payload.meshes) {
      this.owners.set(mesh, entry);
    }
    return payload;
  }

  /** The canonical payload of `key`, now the most recently used — or undefined when the page does not hold it. */
  take(key: string): MeshPayload | undefined {
    return this.touch(key)?.payload;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  /**
   * The geometry that draws `mesh`: for a canonical mesh, the one the cache
   * shares (built by `build` the first time); for any other, `build()`'s,
   * the caller's to dispose.
   */
  geometryOf<T extends BufferGeometry>(mesh: SceneObjectMesh, build: () => T): T {
    const entry = this.owners.get(mesh);
    if (!entry || this.entries.get(entry.key) !== entry) {
      return build();
    }
    const shared = entry.geometries.get(mesh);
    if (shared) {
      return shared as T;
    }
    const geometry = build();
    const dispose = geometry.dispose.bind(geometry);
    this.disposers.set(geometry, dispose);
    // The cache's: freeing a mesh tree that draws it leaves it alone.
    geometry.dispose = () => {};
    entry.geometries.set(mesh, geometry);
    return geometry;
  }

  /** Whether the cache owns `geometry` (it ignores `dispose()`). */
  isShared(geometry: BufferGeometry): boolean {
    return this.disposers.has(geometry);
  }

  /**
   * Count the objects under `root` — attached to a scene or not — as
   * drawing what they draw: a trim never disposes geometry they use. The
   * answered function stops watching; so does `root` being collected.
   */
  watch(root: Object3D): () => void {
    const ref = new WeakRef(root);
    this.roots.add(ref);
    return () => {
      this.roots.delete(ref);
    };
  }

  /** The keys of the scene on screen: none of them is evicted while it shows. */
  setOnScreen(keys: Iterable<string>): void {
    this.onScreen = new Set(keys);
  }

  /**
   * Past the capacity, evict the least recently used entries — none the
   * scene on screen names, none an object under a watched root draws —
   * until the weight is back under {@link TRIM_TO} of it, disposing their
   * geometry.
   */
  trim(): void {
    if (this.weight <= this.capacity) {
      return;
    }
    const target = this.capacity * MeshCache.TRIM_TO;
    const drawn = this.drawnGeometries();
    for (const entry of [...this.entries.values()]) {
      if (this.weight <= target) {
        break;
      }
      if (this.onScreen.has(entry.key) || [...entry.geometries.values()].some(geometry => drawn.has(geometry))) {
        continue;
      }
      this.evict(entry);
    }
  }

  /** Drop every entry and free every geometry no watched object draws (a reconnect to another engine, tests). */
  clear(): void {
    const drawn = this.drawnGeometries();
    for (const entry of [...this.entries.values()]) {
      this.evict(entry, drawn);
    }
  }

  stats(): MeshCacheStats {
    let geometries = 0;
    for (const entry of this.entries.values()) {
      geometries += entry.geometries.size;
    }
    return { entries: this.entries.size, weight: this.weight, capacity: this.capacity, geometries, evicted: this.evicted };
  }

  private touch(key: string): MeshEntry | undefined {
    const entry = this.entries.get(key);
    if (entry) {
      this.entries.delete(key);
      this.entries.set(key, entry);
    }
    return entry;
  }

  /**
   * Forget `entry`, disposing its geometry — except, when `drawn` is given,
   * a geometry still drawn: that one stays the drawing object's, freed with
   * it when that object's tree is freed.
   */
  private evict(entry: MeshEntry, drawn?: ReadonlySet<BufferGeometry>): void {
    this.entries.delete(entry.key);
    this.weight -= entry.weight;
    this.evicted++;
    for (const mesh of entry.payload.meshes) {
      this.owners.delete(mesh);
    }
    for (const geometry of entry.geometries.values()) {
      const dispose = this.disposers.get(geometry)!;
      this.disposers.delete(geometry);
      if (drawn?.has(geometry)) {
        geometry.dispose = dispose;
      } else {
        dispose();
      }
    }
    entry.geometries.clear();
  }

  /** Every geometry an object under a watched root draws. */
  private drawnGeometries(): Set<BufferGeometry> {
    const drawn = new Set<BufferGeometry>();
    for (const ref of [...this.roots]) {
      const root = ref.deref();
      if (!root) {
        this.roots.delete(ref);
        continue;
      }
      root.traverse((object) => {
        const geometry = (object as { geometry?: BufferGeometry }).geometry;
        if (geometry) {
          drawn.add(geometry);
        }
      });
    }
    return drawn;
  }
}

/** The page's one mesh cache: the scenes' payloads and the geometry every viewport object shares. */
export const meshCache = new MeshCache();
