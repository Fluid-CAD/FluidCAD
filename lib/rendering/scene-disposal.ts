import { Shape } from "../common/shape.js";
import { SceneObject } from "../common/scene-object.js";
import { Scene } from "./scene.js";

/**
 * Reclaims the OC (WASM) memory of scene objects the rendering pipeline
 * discards.
 *
 * SceneCompare moves the matched prefix's state maps into the new scene by
 * reference, so the old and new scene share those Shape wrappers. Anything
 * reachable only from the old scene is garbage: the walker collects the
 * wrappers reachable from each side and releases the difference. Raw-handle
 * sets guard wrappers that share one underlying TopoDS handle (`Solid.copy`
 * and `colorMap` entries alias raw handles across wrappers).
 *
 * Wrappers held in feature instance fields (outside the state map) are not
 * walked — features that keep native resources there free them in their
 * `onDestroy` override.
 */
export class SceneDisposal {

  /**
   * Dispose everything the compare pass replaced. `matched` maps old objects
   * that survived (their state moved into the new scene) to their new
   * instances; every other old object is destroyed. `oldSceneShapes` must be
   * collected before compare rewrites the transferred state maps — the
   * records pruned by that rewrite are exactly the resources that need
   * freeing here.
   */
  static disposeReplaced(
    oldScene: Scene,
    newScene: Scene,
    matched: Map<SceneObject, SceneObject>,
    oldSceneShapes: Set<Shape>,
  ): void {
    for (const obj of oldScene.getAllSceneObjects()) {
      if (!matched.has(obj)) {
        obj.destroy();
      }
    }

    const survivors = SceneDisposal.collectShapes(newScene.getAllSceneObjects());
    SceneDisposal.releaseShapes(oldSceneShapes, survivors);
  }

  /**
   * Tear down a whole scene that is being dropped without a successor
   * (forced full rebuild, session teardown). Every object is destroyed and
   * every reachable shape released.
   */
  static disposeScene(scene: Scene): void {
    const shapes = SceneDisposal.collectShapes(scene.getAllSceneObjects());
    for (const obj of scene.getAllSceneObjects()) {
      obj.destroy();
    }
    SceneDisposal.releaseShapes(shapes, new Set());
  }

  /**
   * Release wrappers a state rewrite dropped (the foreign-part rescale
   * swaps every shape of a part for a scaled copy). Anything still reachable
   * from the scene's state maps survives — a consumer that captured the old
   * wrapper keeps a live handle.
   */
  static releaseReplacedShapes(replaced: Set<Shape>, scene: Scene): void {
    const survivors = SceneDisposal.collectShapes(scene.getAllSceneObjects());
    SceneDisposal.releaseShapes(replaced, survivors);
  }

  /** Every Shape wrapper reachable from the objects' state maps. */
  static collectShapes(objects: SceneObject[]): Set<Shape> {
    const shapes = new Set<Shape>();
    const seen = new Set<object>();
    for (const obj of objects) {
      for (const value of obj.getFullState().values()) {
        SceneDisposal.walk(value, shapes, seen);
      }
    }
    return shapes;
  }

  private static releaseShapes(candidates: Set<Shape>, survivors: Set<Shape>): void {
    const retainedRaw = new Set<object>();
    for (const shape of survivors) {
      shape.collectRawHandles(retainedRaw);
    }

    const deletedRaw = new Set<object>();
    for (const shape of candidates) {
      if (!survivors.has(shape)) {
        shape.release(retainedRaw, deletedRaw);
      }
    }
  }

  private static walk(value: unknown, shapes: Set<Shape>, seen: Set<object>): void {
    if (!value || typeof value !== "object") {
      return;
    }
    if (seen.has(value)) {
      return;
    }
    seen.add(value);

    if (value instanceof Shape) {
      shapes.add(value);
      for (const linked of value.getLinkedShapes()) {
        SceneDisposal.walk(linked, shapes, seen);
      }
      return;
    }

    // Never cross into other scene objects — each one's state is walked from
    // the scene list, and following actor references (removedBy/addedBy)
    // here would conflate ownership.
    if (value instanceof SceneObject) {
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        SceneDisposal.walk(item, shapes, seen);
      }
      return;
    }

    if (value instanceof Map) {
      for (const entry of value.values()) {
        SceneDisposal.walk(entry, shapes, seen);
      }
      return;
    }

    if (value instanceof Set) {
      for (const entry of value) {
        SceneDisposal.walk(entry, shapes, seen);
      }
      return;
    }

    // Plain records only ({shape, removedBy}, {sources, results, ...}).
    // Class instances (matrices, planes, raw OC handles) never own Shape
    // wrappers, and recursing into them could wander out of the scene graph.
    const proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) {
      for (const entry of Object.values(value)) {
        SceneDisposal.walk(entry, shapes, seen);
      }
    }
  }
}
