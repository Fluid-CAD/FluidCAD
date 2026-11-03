import { SceneObject } from "../common/scene-object.js";
import { Shape } from "../common/shape.js";
import { Part } from "../features/part.js";
import { GeneratedCode } from "../sdk/generated-code.js";
import { ActorRecords } from "./actor-records.js";
import { GeneratedBuildReports } from "./generated-build-report.js";
import { SceneCompare } from "./scene-compare.js";
import { SceneDisposal, type ShapeKeeper } from "./scene-disposal.js";
import type { Scene } from "./scene.js";

/** How much the template cache holds at most. */
export type GeneratedCacheLimits = {
  /** The most templates it holds. */
  maxEntries: number;
  /** The most it holds by its size estimate, in bytes (see {@link GeneratedTemplateCache}). */
  maxSize: number;
};

/** What the template cache holds now, its limits, and what it did since the process started. */
export type GeneratedCacheStats = GeneratedCacheLimits & {
  /** Templates it holds. */
  entries: number;
  /** Their size estimate, in bytes. */
  size: number;
  /** Templates renders took from it. */
  taken: number;
  /** Templates it disposed: evicted for room, for a code change, cleared, or retired stale. */
  disposed: number;
};

/** One retired template: its subtree's objects (old, kept only to pair with) and the build state they handed over. */
type CacheEntry = {
  key: string;
  definition: string;
  /** The retired part, then its members — the order {@link GeneratedTemplateCache.subtreeOf} walks. */
  objects: SceneObject[];
  /** Each object's built state, detached from it (`SceneObject.detachState`): the entry owns it. */
  states: Map<string, any>[];
  errors: ({ message: string; kernelTrap: boolean } | null)[];
  /** Every wrapper the states reach. */
  shapes: Set<Shape>;
  /** The raw kernel handles those wrappers point at. */
  raw: Set<object>;
  size: number;
};

/**
 * The parts generators made, kept across renders once no scene holds them:
 * least recently used goes first, bounded by a count and a size estimate.
 * With it a value dragged back, an undo, or a preview cancelled finds its
 * parts built (P2).
 *
 * **What it keeps.** A template part's *built state* — the shapes and
 * records of the part and its members (its body, its frames, its
 * connectors) — never the scene objects themselves. A scene object belongs
 * to its scene: its id, its place in the scene's structure, its source
 * location (the `defineAssembly()` line may have moved), its units and
 * names are the declaring render's. The next render declares the template
 * afresh (`GeneratedTemplates.materialize`), and a hit hands that fresh
 * part the cached state, as the assembly compare hands a paired part its
 * predecessor's: actor-stamped records (face colours, removals) remapped
 * onto the new objects, errors carried, everything marked cached — so the
 * part renders `fromCache` and the UI takes its pose-only path.
 *
 * **Keys.** `Part.generatedBuildKey`: the template's identity key, the
 * units it is made and read in, the detail tier and the definition's code
 * version (see `GeneratedCode`). Equal keys hold the same shapes.
 *
 * **Ownership — a template's build is in one place.** In the scene holding
 * its part, or here; never both.
 * - A compare that leaves an old template unpaired retires it here
 *   ({@link retire}): its objects hand their state over and keep none.
 * - A render takes an entry for a template it holds unbuilt ({@link
 *   takeInto}): the state goes to the new part and the entry is gone — the
 *   scene owns it now, and it comes back only when a later compare leaves
 *   it unpaired again.
 * - What is held here is released once, by the cache only: on eviction
 *   for room, on a code change, on {@link clear}, or at once when it is
 *   retired stale (its code changed, or the kernel trapped building it).
 *   The cache is a {@link ShapeKeeper}: no scene's disposal pass frees a
 *   shape it holds — an older scene the template was carried over from
 *   still names it.
 * - A scene disposed whole (a recompute, a session closed, a scratch
 *   render) frees the templates it holds with it: they never came here.
 *
 * **Size estimate.** The kernel's memory can't be read per shape, so the
 * estimate is what an entry's shapes hold in triangulation — 16 bytes per
 * number of their cached mesh pieces (vertices, normals, indices: the JS
 * pieces' doubles and the kernel's own copy on its faces) — plus 1 KB per
 * wrapper for its B-rep handle. It ranks big parts against small ones,
 * which is what the bound needs; it is not a measurement.
 */
export class GeneratedTemplateCache implements ShapeKeeper {

  /** 256 templates, 256 MB by estimate. */
  static readonly DEFAULT_LIMITS: Readonly<GeneratedCacheLimits> = Object.freeze({ maxEntries: 256, maxSize: 256 * 1024 * 1024 });

  private static readonly BYTES_PER_MESH_NUMBER = 16;

  private static readonly BYTES_PER_WRAPPER = 1024;

  /** The one cache: the kernel is one per process, and so are the shapes it holds. */
  static readonly shared = new GeneratedTemplateCache();

  /** Entries by key, least recently used first. */
  private readonly entries = new Map<string, CacheEntry>();

  /** Every wrapper the entries hold. */
  private readonly held = new Set<Shape>();

  /** Every raw handle they point at, and how many entries name it. */
  private readonly heldRaw = new Set<object>();
  private readonly rawCounts = new Map<object, number>();

  /** Parts already retired: a compare run twice over one old scene retires each once. */
  private readonly retired = new WeakSet<Part>();

  private size = 0;
  private limits: GeneratedCacheLimits = { ...GeneratedTemplateCache.DEFAULT_LIMITS };
  private takenCount = 0;
  private disposedCount = 0;

  private constructor() {
    SceneDisposal.keep(this);
  }

  /**
   * Take in the templates an old scene's compare left unpaired — `parts`,
   * top-level parts a generator made. Each part's objects hand their build
   * state over (they keep none). A template whose definition is in
   * `options.rebuild` (its code changed, as the host says), whose code
   * version is no longer current (`GeneratedCode.isCurrent`), or whose
   * build trapped the kernel is disposed at once instead; one whose key the
   * cache holds already is too (the held one stays).
   *
   * Then the cache trims to its limits — never evicting `options.keep`, the
   * keys the new scene holds unbuilt: the render about to start takes them
   * ({@link takeInto}), and the old scene's templates must not push them
   * out first.
   */
  retire(parts: readonly Part[], options: { rebuild?: ReadonlySet<string>; keep?: ReadonlySet<string> } = {}): void {
    const rebuild = options.rebuild;
    for (const part of parts) {
      if (!part.generatedBy || part.getParent() !== null || this.retired.has(part)) {
        continue;
      }
      this.retired.add(part);
      const entry = GeneratedTemplateCache.entryOf(part);
      const stale = rebuild?.has(part.generatedBy.definition) === true
        || !GeneratedCode.isCurrent(part.generatedBy.definition, part.generatedBy.code)
        || entry.errors.some(error => error?.kernelTrap === true);
      if (stale) {
        this.dispose(entry);
        continue;
      }
      const held = this.entries.get(entry.key);
      if (held) {
        this.dispose(entry);
        this.entries.delete(held.key);
        this.entries.set(held.key, held);
        continue;
      }
      this.add(entry);
    }
    this.trim(options.keep);
  }

  /**
   * Hand every template `scene` holds unbuilt — a top-level generated part
   * the compare did not carry over — the state the cache holds for its key,
   * if it holds one: the part and its members take the state, are marked
   * cached, and the entry is gone. Runs as a render starts, so a scene
   * dropped before it renders never took anything.
   */
  takeInto(scene: Scene): void {
    if (this.entries.size === 0) {
      return;
    }
    for (const obj of scene.getAllSceneObjects()) {
      if (obj instanceof Part && obj.generatedBy && obj.getParent() === null && !scene.isCached(obj)) {
        this.take(obj, scene);
      }
    }
    this.trim();
  }

  /** The code of these definitions changed: every template of theirs the cache holds is disposed. */
  dropDefinitions(ids: Iterable<string>): void {
    const dropped = new Set(ids);
    if (dropped.size === 0) {
      return;
    }
    for (const entry of [...this.entries.values()]) {
      if (dropped.has(entry.definition)) {
        this.remove(entry);
        this.dispose(entry);
      }
    }
  }

  /** Dispose everything the cache holds — a recompute from scratch, a model unloaded, a test's end. */
  clear(): void {
    for (const entry of [...this.entries.values()]) {
      this.remove(entry);
      this.dispose(entry);
    }
  }

  /** Change the limits (either or both); the cache trims to them at once. Each is a whole number, 0 or more. */
  setLimits(limits: Partial<GeneratedCacheLimits>): void {
    const next = { ...this.limits, ...limits };
    for (const [name, value] of Object.entries(next)) {
      if (!Number.isInteger(value) || value < 0) {
        throw new Error(`the template cache's ${name} is a whole number, 0 or more — got ${String(value)}`);
      }
    }
    this.limits = next;
    this.trim();
  }

  getStats(): GeneratedCacheStats {
    return {
      ...this.limits,
      entries: this.entries.size,
      size: this.size,
      taken: this.takenCount,
      disposed: this.disposedCount,
    };
  }

  heldShapes(): ReadonlySet<Shape> {
    return this.held;
  }

  heldRawHandles(): ReadonlySet<object> {
    return this.heldRaw;
  }

  private take(part: Part, scene: Scene): void {
    const key = part.generatedBuildKey();
    const entry = key === null ? undefined : this.entries.get(key);
    if (!entry) {
      return;
    }
    this.remove(entry);
    const subtree = GeneratedTemplateCache.subtreeOf(part);
    const fits = subtree.length === entry.objects.length
      && subtree.every((obj, i) => SceneCompare.matches(entry.objects[i], obj));
    if (!fits) {
      // Equal keys declare equal subtrees; should one ever not, its state
      // can't be laid onto the other's objects.
      this.dispose(entry);
      return;
    }
    const map = new Map<SceneObject, SceneObject>();
    entry.objects.forEach((obj, i) => map.set(obj, subtree[i]));
    subtree.forEach((obj, i) => {
      const state = entry.states[i];
      ActorRecords.remap(state, map);
      obj.restoreState(state);
      const error = entry.errors[i];
      if (error) {
        obj.setError(error.message, { kernelTrap: error.kernelTrap });
      }
      scene.markCached(obj);
    });
    GeneratedBuildReports.recordTaken(part);
    this.takenCount++;
  }

  private add(entry: CacheEntry): void {
    this.entries.set(entry.key, entry);
    this.size += entry.size;
    for (const shape of entry.shapes) {
      this.held.add(shape);
    }
    for (const raw of entry.raw) {
      const count = this.rawCounts.get(raw) ?? 0;
      this.rawCounts.set(raw, count + 1);
      this.heldRaw.add(raw);
    }
  }

  /** Forget `entry` — it leaves the cache (taken or about to be disposed). */
  private remove(entry: CacheEntry): void {
    if (this.entries.get(entry.key) !== entry) {
      return;
    }
    this.entries.delete(entry.key);
    this.size -= entry.size;
    for (const shape of entry.shapes) {
      this.held.delete(shape);
    }
    for (const raw of entry.raw) {
      const count = (this.rawCounts.get(raw) ?? 1) - 1;
      if (count <= 0) {
        this.rawCounts.delete(raw);
        this.heldRaw.delete(raw);
      } else {
        this.rawCounts.set(raw, count);
      }
    }
  }

  /** Release what an entry no one holds any more owns: its shapes, once, and its retired objects. */
  private dispose(entry: CacheEntry): void {
    SceneDisposal.releaseOwned(entry.shapes);
    for (const obj of entry.objects) {
      obj.destroy();
    }
    this.disposedCount++;
  }

  /**
   * Evict least recently used entries until the cache is within its limits,
   * sparing the keys in `keep` — the cache may stay over its limits by
   * those until the render that wants them takes them.
   */
  private trim(keep?: ReadonlySet<string>): void {
    for (const entry of [...this.entries.values()]) {
      if (this.entries.size <= this.limits.maxEntries && this.size <= this.limits.maxSize) {
        return;
      }
      if (keep?.has(entry.key)) {
        continue;
      }
      this.remove(entry);
      this.dispose(entry);
    }
  }

  /** A retired part's entry: its subtree's state detached, its shapes, raw handles and size estimate. */
  private static entryOf(part: Part): CacheEntry {
    const objects = GeneratedTemplateCache.subtreeOf(part);
    const errors = objects.map(obj => {
      const message = obj.getError();
      return message ? { message, kernelTrap: obj.isKernelTrap() } : null;
    });
    const states = objects.map(obj => obj.detachState());
    const shapes = SceneDisposal.collectStateShapes(states);
    const raw = new Set<object>();
    let size = 0;
    for (const shape of shapes) {
      shape.collectRawHandles(raw);
      size += GeneratedTemplateCache.sizeOf(shape);
    }
    return { key: part.generatedBuildKey()!, definition: part.generatedBy!.definition, objects, states, errors, shapes, raw, size };
  }

  /** The size estimate of one wrapper (see the class comment). */
  private static sizeOf(shape: Shape): number {
    let numbers = 0;
    const pieces = shape.getMeshPieces();
    if (pieces) {
      for (const face of pieces.faces) {
        numbers += face.vertices.length + face.normals.length + face.indices.length;
      }
      for (const mesh of pieces.meshes) {
        numbers += mesh.vertices.length + mesh.normals.length + mesh.indices.length
          + (mesh.faceMapping?.length ?? 0) + (mesh.faceSides?.length ?? 0);
      }
    }
    return GeneratedTemplateCache.BYTES_PER_WRAPPER + numbers * GeneratedTemplateCache.BYTES_PER_MESH_NUMBER;
  }

  /** A part and everything under it, each node before its children — the order compares pair subtrees in. */
  private static subtreeOf(root: SceneObject): SceneObject[] {
    const out: SceneObject[] = [root];
    for (const child of root.getChildren()) {
      out.push(...GeneratedTemplateCache.subtreeOf(child));
    }
    return out;
  }
}
