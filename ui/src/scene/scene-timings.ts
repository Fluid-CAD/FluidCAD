import { addFrameHook } from '../meshes/frame-hooks';
import type { MeshCacheStats } from './mesh-cache';
import type { SceneMeshNeeds } from './scene-meshes';

/** One scene's numbers on the page, as {@link SceneTimings} keeps them. */
export type SceneTimingRecord = {
  /** When the message arrived (`Date.now()`). */
  at: number;
  version?: number;
  sceneKind?: string;
  /** The scene was an assembly preview's. */
  preview: boolean;
  /** The message's length on the wire, in characters (≈ bytes). */
  bytes: number;
  /** `JSON.parse` of it. */
  parseMs: number;
  /** Shapes that came by reference, and whole payloads kept. */
  refs: number;
  whole: number;
  /** Keeping the whole payloads and resolving the references the cache held. */
  prepareMs: number;
  /** References fetched from `POST /api/meshes`, and how long that took. */
  fetched: number;
  fetchMs?: number;
  /** The scene could not be drawn whole and was skipped (a newer one replaces it). */
  skipped: boolean;
  /** `applySceneRendered`: the viewer rebuilt (part tree or assembly instances) and every scene service. */
  applyMs?: number;
  /** Of it, the viewer's own rebuild (`updateView` / `updateAssemblyView`). */
  viewMs?: number;
  /** Assembly scenes: the instances whose group was kept (unchanged content) and the ones rebuilt. */
  instances?: { kept: number; rebuilt: number };
  /** The first frame drawn after it — three.js uploads new geometry to the GPU there. */
  frameMs?: number;
  /** The mesh cache once the scene is drawn. */
  cache?: MeshCacheStats;
};

declare global {
  interface Window {
    /** The last {@link SceneTimings.CAPACITY} scenes' page timings, oldest first. */
    __fluidcadSceneTimings?: SceneTimingRecord[];
  }
}

/**
 * Every scene's cost on the page, kept for measuring (generators S6b): a
 * ring buffer on `window.__fluidcadSceneTimings` — bytes, parse, mesh
 * resolution and fetches, the viewer's rebuild and the first frame after
 * it. Never logged unless asked: `localStorage['fluidcad.sceneTimings'] =
 * '1'` prints one compact `console.debug` line per scene.
 */
export class SceneTimings {
  static readonly CAPACITY = 200;
  static readonly LOG_FLAG = 'fluidcad.sceneTimings';

  private static readonly open = new WeakMap<object, SceneTimingRecord>();

  /** A scene arrived: `bytes` long, parsed in `parseMs`. */
  static received(msg: Record<string, unknown>, bytes: number, parseMs: number): void {
    SceneTimings.open.set(msg, {
      at: Date.now(),
      version: typeof msg.sceneVersion === 'number' ? msg.sceneVersion : undefined,
      sceneKind: typeof msg.sceneKind === 'string' ? msg.sceneKind : undefined,
      preview: !!msg.preview,
      bytes,
      parseMs: SceneTimings.round(parseMs),
      refs: 0,
      whole: 0,
      prepareMs: 0,
      fetched: 0,
      skipped: false,
    });
  }

  static prepared(msg: object, needs: SceneMeshNeeds, ms: number): void {
    const record = SceneTimings.open.get(msg);
    if (record) {
      record.refs = needs.refs;
      record.whole = needs.whole;
      record.prepareMs = SceneTimings.round(ms);
    }
  }

  static fetched(msg: object, keys: number, ms: number): void {
    const record = SceneTimings.open.get(msg);
    if (record) {
      record.fetched = keys;
      record.fetchMs = SceneTimings.round(ms);
    }
  }

  /** The viewer rebuilt the scene in `ms` (part tree or assembly instances, `instances` kept and rebuilt). */
  static viewed(msg: object, ms: number, instances?: { kept: number; rebuilt: number }): void {
    const record = SceneTimings.open.get(msg);
    if (record) {
      record.viewMs = SceneTimings.round(ms);
      if (instances) {
        record.instances = { kept: instances.kept, rebuilt: instances.rebuilt };
      }
    }
  }

  /** The scene is drawn (`applyMs`); its first frame's draw is timed when it comes. */
  static applied(msg: object, ms: number, cache: MeshCacheStats): void {
    const record = SceneTimings.close(msg);
    if (!record) {
      return;
    }
    record.applyMs = SceneTimings.round(ms);
    record.cache = cache;
    // The hooks run right before the draw; the draw is the rest of the
    // frame's task, over by the time a microtask queued here runs.
    const stop = addFrameHook(() => {
      stop();
      const start = performance.now();
      queueMicrotask(() => {
        record.frameMs = SceneTimings.round(performance.now() - start);
        SceneTimings.log(record);
      });
    });
  }

  static skipped(msg: object): void {
    const record = SceneTimings.close(msg);
    if (record) {
      record.skipped = true;
      SceneTimings.log(record);
    }
  }

  private static close(msg: object): SceneTimingRecord | undefined {
    const record = SceneTimings.open.get(msg);
    if (!record) {
      return undefined;
    }
    SceneTimings.open.delete(msg);
    const buffer = (window.__fluidcadSceneTimings ??= []);
    buffer.push(record);
    if (buffer.length > SceneTimings.CAPACITY) {
      buffer.splice(0, buffer.length - SceneTimings.CAPACITY);
    }
    return record;
  }

  private static log(record: SceneTimingRecord): void {
    let enabled = false;
    try {
      enabled = window.localStorage?.getItem(SceneTimings.LOG_FLAG) === '1';
    } catch {
      enabled = false;
    }
    if (enabled) {
      console.debug(
        `[scene] v${record.version ?? '?'} ${record.bytes} B parse ${record.parseMs} ms, ${record.refs} refs / ${record.whole} whole`
        + `, prepare ${record.prepareMs} ms${record.fetched ? `, fetched ${record.fetched} in ${record.fetchMs} ms` : ''}`
        + (record.skipped ? ', skipped' : `, apply ${record.applyMs} ms (view ${record.viewMs ?? '?'} ms), frame ${record.frameMs ?? '?'} ms`),
      );
    }
  }

  private static round(ms: number): number {
    return Math.round(ms * 10) / 10;
  }
}
