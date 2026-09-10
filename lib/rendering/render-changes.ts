import { SceneObject } from "../common/scene-object.js";
import type { Scene } from "./scene.js";
import { Sketch } from "../features/2d/sketch.js";
import { ShapeInterference } from "../oc/shape-interference.js";
import type { WorldBounds } from "../oc/shape-interference.js";
import { EntitySummaryBuilder } from "../oc/measure/entity-summary.js";

export type RenderChangeLocation = { filePath: string; line: number; column: number };

/** Axis-aligned bounds in the document unit, rounded to its meaningful precision. */
export type RenderChangeBounds = { min: [number, number, number]; max: [number, number, number] };

/** One scene object the render built (or built again). */
export type RenderChangeEntry = {
  /** The object's id in THIS render — what `get_scene_summary` reports now. */
  sceneObjectId: string;
  name: string;
  kind: string;
  sourceLocation?: RenderChangeLocation;
  /** Shapes the object added to the scene in this render. */
  shapes: number;
  /**
   * Exact (`Bnd_Box`) bounds over the object's added solids: `before` from
   * the previous render's instance, `after` from this one. Either side is
   * absent when that instance added no solid.
   */
  bounds?: { before?: RenderChangeBounds; after?: RenderChangeBounds };
};

/** A scene object the previous render had and this one does not. */
export type RenderChangeRemoval = {
  /** The object's id in the PREVIOUS render. */
  sceneObjectId: string;
  name: string;
  kind: string;
  sourceLocation?: RenderChangeLocation;
};

/**
 * What one render changed, in terms of the incremental compare: the objects
 * whose geometry was built again (`rebuilt`), the new ones (`added`), the
 * ones that went away (`removed`), and how many were served from cache
 * (`reused`). Every list is capped; `truncated` counts the entries dropped.
 */
export type RenderChanges = {
  rebuilt: RenderChangeEntry[];
  added: RenderChangeEntry[];
  removed: RenderChangeRemoval[];
  reused: number;
  truncated?: number;
};

type PreviousRecord = {
  key: string;
  sceneObjectId: string;
  name: string;
  kind: string;
  sourceLocation?: RenderChangeLocation;
  bounds?: WorldBounds;
};

/**
 * Turns the incremental compare's reuse decision into data an agent can act
 * on. Nothing here runs unless a render explicitly asks for a change summary:
 * the compare passes call {@link captureBefore} only when handed a tracker,
 * and the render pipeline only creates one for a request flagged `changes`.
 * Hosts and the UI never ask, so a person typing in the editor pays nothing.
 *
 * Two moments matter. `captureBefore` runs inside the compare, after the
 * matched prefix is decided and BEFORE the replaced old objects are
 * disposed: it records identity and exact bounds for the old objects that
 * did not survive (rebuilt or removed), and only those. `summarize` runs
 * after the new scene rendered and pairs those records with the objects the
 * scene did not serve from cache. Bounds only; volumes are a GProp per shape
 * and stay behind `get_shape_properties`.
 *
 * Listing rule: internal objects (a sketch's own plane) and everything inside
 * a sketch (its geometry and constraints) are folded into their sketch, so
 * the summary reads at feature granularity, the same rows the timeline shows.
 */
export class RenderChangeTracker {

  static readonly DEFAULT_LIMIT = 50;

  private readonly previous: PreviousRecord[] = [];

  constructor(private readonly limit: number = RenderChangeTracker.DEFAULT_LIMIT) {}

  /**
   * Compare hook. `matched` maps the old objects that survived (their state
   * moved into the new scene) to their new instances; every other listed old
   * object is recorded with its bounds while its shapes are still alive. An
   * empty map records the whole scene — the forced-rebuild recompute, where
   * no compare runs and everything is built again.
   */
  captureBefore(oldScene: Scene, matched: ReadonlyMap<SceneObject, SceneObject>): void {
    for (const obj of oldScene.getAllSceneObjects()) {
      if (matched.has(obj) || !RenderChangeTracker.isListed(obj)) {
        continue;
      }
      this.previous.push({
        key: RenderChangeTracker.identityKey(obj),
        ...RenderChangeTracker.identity(obj),
        bounds: RenderChangeTracker.solidBounds(obj),
      });
    }
  }

  /**
   * The rendered scene against what `captureBefore` recorded. Objects the
   * scene served from cache count as reused; the rest pair with a recorded
   * old object of the same identity (rebuilt) or stand alone (added);
   * records left unpaired were removed.
   */
  summarize(scene: Scene): RenderChanges {
    const decimals = EntitySummaryBuilder.decimalsFor(scene.unit);
    const queues = new Map<string, PreviousRecord[]>();
    for (const record of this.previous) {
      const queue = queues.get(record.key);
      if (queue) {
        queue.push(record);
      } else {
        queues.set(record.key, [record]);
      }
    }

    const rebuilt: RenderChangeEntry[] = [];
    const added: RenderChangeEntry[] = [];
    let reused = 0;
    for (const obj of scene.getAllSceneObjects()) {
      if (!RenderChangeTracker.isListed(obj)) {
        continue;
      }
      if (scene.isCached(obj)) {
        reused++;
        continue;
      }
      const entry: RenderChangeEntry = {
        ...RenderChangeTracker.identity(obj),
        shapes: obj.getAddedShapes().length,
      };
      const after = RenderChangeTracker.solidBounds(obj);
      const before = queues.get(RenderChangeTracker.identityKey(obj))?.shift();
      const bounds = RenderChangeTracker.boundsPair(before?.bounds, after, decimals);
      if (bounds) {
        entry.bounds = bounds;
      }
      if (before) {
        rebuilt.push(entry);
      } else {
        added.push(entry);
      }
    }

    const removed: RenderChangeRemoval[] = [];
    for (const record of this.previous) {
      const queue = queues.get(record.key);
      if (queue && queue.includes(record)) {
        const { key: _key, bounds: _bounds, ...removal } = record;
        removed.push(removal);
      }
    }

    return this.capped(rebuilt, added, removed, reused);
  }

  /** The summary of a render that was deduplicated away: nothing built, everything listed reused. */
  summarizeUnchanged(scene: Scene): RenderChanges {
    let reused = 0;
    for (const obj of scene.getAllSceneObjects()) {
      if (RenderChangeTracker.isListed(obj)) {
        reused++;
      }
    }
    return { rebuilt: [], added: [], removed: [], reused };
  }

  /** Feature-granularity rows: no internal helpers, nothing inside a sketch. */
  static isListed(obj: SceneObject): boolean {
    if (obj.isInternal()) {
      return false;
    }
    for (let parent = obj.getParent(); parent; parent = parent.getParent()) {
      if (parent instanceof Sketch) {
        return false;
      }
    }
    return true;
  }

  private capped(
    rebuilt: RenderChangeEntry[],
    added: RenderChangeEntry[],
    removed: RenderChangeRemoval[],
    reused: number,
  ): RenderChanges {
    const dropped = Math.max(0, rebuilt.length - this.limit)
      + Math.max(0, added.length - this.limit)
      + Math.max(0, removed.length - this.limit);
    const changes: RenderChanges = {
      rebuilt: rebuilt.slice(0, this.limit),
      added: added.slice(0, this.limit),
      removed: removed.slice(0, this.limit),
      reused,
    };
    if (dropped > 0) {
      changes.truncated = dropped;
    }
    return changes;
  }

  /**
   * How an object is recognised across renders: its custom name when it has
   * one, else its unique type. Same-key objects pair in scene order, so an
   * unnamed feature inserted mid-tree shifts the pairing of the unnamed
   * features of that type after it — the bounds show the shift.
   */
  private static identityKey(obj: SceneObject): string {
    if (obj.hasCustomName()) {
      return `name:${obj.getName()}`;
    }
    return `type:${obj.getUniqueType()}`;
  }

  private static identity(obj: SceneObject): {
    sceneObjectId: string; name: string; kind: string; sourceLocation?: RenderChangeLocation;
  } {
    const location = obj.getSourceLocation();
    return {
      sceneObjectId: obj.id,
      name: obj.hasCustomName() ? obj.getName() : obj.getDisplayType(),
      kind: obj.getType(),
      ...(location ? { sourceLocation: { filePath: location.filePath, line: location.line, column: location.column } } : {}),
    };
  }

  /** Union of the exact bounds of the object's added solids; undefined when it added none. */
  private static solidBounds(obj: SceneObject): WorldBounds | undefined {
    let union: WorldBounds | undefined;
    for (const shape of obj.getAddedShapes()) {
      if (!shape.isSolid()) {
        continue;
      }
      let bounds: WorldBounds;
      try {
        bounds = ShapeInterference.bounds(shape.getShape());
      } catch (error) {
        // A diagnostic must never fail the render it describes.
        console.warn(`render changes: bounds of ${obj.getUniqueType()} unavailable:`, error);
        continue;
      }
      if (!union) {
        union = { min: [...bounds.min], max: [...bounds.max] };
        continue;
      }
      for (let axis = 0; axis < 3; axis++) {
        union.min[axis] = Math.min(union.min[axis], bounds.min[axis]);
        union.max[axis] = Math.max(union.max[axis], bounds.max[axis]);
      }
    }
    return union;
  }

  private static boundsPair(
    before: WorldBounds | undefined,
    after: WorldBounds | undefined,
    decimals: number,
  ): RenderChangeEntry['bounds'] | undefined {
    if (!before && !after) {
      return undefined;
    }
    const pair: NonNullable<RenderChangeEntry['bounds']> = {};
    if (before) {
      pair.before = RenderChangeTracker.roundBounds(before, decimals);
    }
    if (after) {
      pair.after = RenderChangeTracker.roundBounds(after, decimals);
    }
    return pair;
  }

  private static roundBounds(bounds: WorldBounds, decimals: number): RenderChangeBounds {
    const round = (v: [number, number, number]): [number, number, number] => [
      EntitySummaryBuilder.round(v[0], decimals),
      EntitySummaryBuilder.round(v[1], decimals),
      EntitySummaryBuilder.round(v[2], decimals),
    ];
    return { min: round(bounds.min), max: round(bounds.max) };
  }
}
