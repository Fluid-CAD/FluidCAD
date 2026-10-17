import type { SceneObject } from "../common/scene-object.js";
import type { Shape } from "../common/shape.js";
import { callSiteKey } from "../common/call-site.js";
import { bodiesBuiltBy, hardRemovalOf, successorsOf } from "../helpers/live-solids.js";

/**
 * A stable key per live solid, by lineage rather than by holder: the feature
 * that CREATED the body (its root), the body's ordinal among that feature's
 * creations, and a branch index on every removal that split it into more
 * than one successor. A fillet, a chamfer, a cut or a move takes the body
 * off its holder and hands its own result on under the same key, so the key
 * survives the holder changing every time a feature touches the body — and
 * survives a re-render that rebuilds every holder after an upstream edit,
 * where shape ids (random per Shape) do not.
 *
 * Key format (`<rootKey>:<ordinal>` with `.<branch>` suffixes):
 *
 *   name:bracket:1          a root with a `.name('bracket')`
 *   extrude@/a.fluid.js:12:3:1   an unnamed root, by call site
 *   extrude@/a.fluid.js:12:3#2:1 … that ran more than once (loop, repeat)
 *   extrude@/a.fluid.js:12:3:1.2 the second piece a split made of it
 *   id:<object id>:1        a root with neither a name nor a source location
 *
 * The forward walk is the live-operand walk of `liveSolidsOf` (hard removals
 * only, `successors ?? bodiesBuiltBy(remover)`), with one addition: a body a
 * feature moved over unchanged (a copy's original) is followed to its new
 * holder. The first root to reach a live solid, in timeline order, keeps it:
 * a body two lineages fuse into is the earlier root's.
 */
export class BodyLineage {
  /**
   * Keys for every live solid `sceneObjects` hold — timeline order, so the
   * earliest root wins a fused body. `occurrences` is the render's per-call-
   * site occurrence index (`computeCallSiteOccurrences`). `scope` is the
   * render's scope: a removal by a feature outside it has not happened in
   * that view (the rollback pass), so the body is live at the holder before it.
   */
  static keysFor(
    sceneObjects: SceneObject[],
    occurrences: Map<SceneObject, number>,
    scope?: Set<SceneObject>,
  ): Map<Shape, string> {
    const keys = new Map<Shape, string>();
    for (const obj of sceneObjects) {
      const roots = bodiesBuiltBy(obj);
      if (roots.length === 0) {
        continue;
      }
      const rootKey = BodyLineage.rootKey(obj, occurrences);
      roots.forEach((solid, index) => {
        BodyLineage.follow(obj, solid, `${rootKey}:${index + 1}`, keys, scope, new Set());
      });
    }
    return keys;
  }

  /** The root's identity: its custom name, else its call site (with the occurrence when it ran more than once), else its id. */
  static rootKey(obj: SceneObject, occurrences: Map<SceneObject, number>): string {
    if (obj.hasCustomName()) {
      return `name:${obj.getName()}`;
    }
    const site = callSiteKey(obj);
    if (site === null) {
      return `id:${obj.id}`;
    }
    const occurrence = occurrences.get(obj);
    return occurrence === undefined ? site : `${site}#${occurrence}`;
  }

  private static follow(
    holder: SceneObject,
    solid: Shape,
    key: string,
    keys: Map<Shape, string>,
    scope: Set<SceneObject> | undefined,
    visited: Set<string>,
  ): void {
    // A body moved over unchanged keeps its Shape: guard on the pair, so the
    // walk continues to the new holder and still cannot loop.
    const step = `${holder.id}/${solid.id}`;
    if (visited.has(step)) {
      return;
    }
    visited.add(step);

    if (holder.getShapes({}, 'solid').includes(solid)) {
      BodyLineage.claim(solid, key, keys);
      return;
    }
    const removal = hardRemovalOf(holder, solid);
    if (!removal) {
      return;
    }
    if (scope && !scope.has(removal.removedBy)) {
      // Out of this view, the removal has not happened: the body is live
      // at the holder it had before the remover (getOwnShapes' rule).
      BodyLineage.claim(solid, key, keys);
      return;
    }
    const successors = successorsOf(removal);
    if (successors.length === 1) {
      BodyLineage.follow(removal.removedBy, successors[0], key, keys, scope, visited);
      return;
    }
    successors.forEach((successor, branch) => {
      BodyLineage.follow(removal.removedBy, successor, `${key}.${branch + 1}`, keys, scope, visited);
    });
  }

  /** First root to reach a solid keeps it. */
  private static claim(solid: Shape, key: string, keys: Map<Shape, string>): void {
    if (!keys.has(solid)) {
      keys.set(solid, key);
    }
  }
}
