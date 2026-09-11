// The handle RepeatBase.instance(k) returns: a lazy whole-geometry selection
// over the features repeated into slot k (the originals for the original's
// slot, their clones elsewhere), usable wherever a whole-geometry operand
// is accepted — `fillet(2, r.instance(1))`, `edge().from(r.instance(1))`.
// When the slot holds exactly one repeated feature the instance ALSO
// forwards that feature's bucket accessors, so `r.instance(1).endEdges()`
// is the clone's own end-edge bucket — the constant-free way to address
// one instance of a pattern.

import { LazySelectionSceneObject } from "./lazy-scene-object.js";
import type { SceneObject } from "../common/scene-object.js";
import type { Shape, ShapeFilter } from "../common/shape.js";
import type { ShapeType } from "../common/shape-type.js";
import type { RepeatBase } from "./repeat-base.js";
import type { EdgeFilterBuilder } from "../filters/edge/edge-filter.js";
import type { FaceFilterBuilder } from "../filters/face/face-filter.js";

type EdgeAccessorArgs = (number | EdgeFilterBuilder)[];
type FaceAccessorArgs = (number | FaceFilterBuilder)[];

export class RepeatInstance extends LazySelectionSceneObject {

  constructor(
    private readonly instanceName: string,
    readonly owner: RepeatBase,
    readonly slot: number,
  ) {
    // The resolver is never run — build() is a no-op and getShapes() reads
    // the slot's features live (see below).
    super(instanceName, () => [], owner);
  }

  /** The slot's repeated features, not the repeat container: what the
   * selection is built from, and what a clone of a consumer must follow. */
  override getDependencies(): SceneObject[] {
    return this.owner.getInstanceRoots(this.slot);
  }

  // The instance never owns geometry: it reads the slot's features live and
  // forwards consumption to them. Holding copies of their solids would make
  // the instance shadow the feature as the solid's owner (consumers map
  // shape → latest holder), so a fillet on `r.instance(1)` would consume the
  // handle and leave the clone's untouched box in the scene.
  override build(): void {}

  override getShapes(filter?: ShapeFilter, type?: ShapeType, scope?: Set<SceneObject>): Shape[] {
    return this.owner.getInstanceRoots(this.slot).flatMap(root => root.getShapes(filter, type, scope));
  }

  override removeShape(shape: Shape, removedBy: SceneObject): void {
    for (const root of this.owner.getInstanceRoots(this.slot)) {
      const held = root.getShapes({ excludeMeta: false, excludeGuide: false });
      if (held.some(s => s === shape)) {
        root.removeShape(shape, removedBy);
      }
    }
  }

  override removeShapes(removedBy: SceneObject, force?: boolean): void {
    for (const root of this.owner.getInstanceRoots(this.slot)) {
      root.removeShapes(removedBy, force);
    }
  }

  startFaces(...args: FaceAccessorArgs): LazySelectionSceneObject {
    return this.forward('startFaces', args);
  }

  endFaces(...args: FaceAccessorArgs): LazySelectionSceneObject {
    return this.forward('endFaces', args);
  }

  sideFaces(...args: FaceAccessorArgs): LazySelectionSceneObject {
    return this.forward('sideFaces', args);
  }

  internalFaces(...args: FaceAccessorArgs): LazySelectionSceneObject {
    return this.forward('internalFaces', args);
  }

  capFaces(...args: FaceAccessorArgs): LazySelectionSceneObject {
    return this.forward('capFaces', args);
  }

  startEdges(...args: EdgeAccessorArgs): LazySelectionSceneObject {
    return this.forward('startEdges', args);
  }

  endEdges(...args: EdgeAccessorArgs): LazySelectionSceneObject {
    return this.forward('endEdges', args);
  }

  sideEdges(...args: EdgeAccessorArgs): LazySelectionSceneObject {
    return this.forward('sideEdges', args);
  }

  internalEdges(...args: EdgeAccessorArgs): LazySelectionSceneObject {
    return this.forward('internalEdges', args);
  }

  capEdges(...args: EdgeAccessorArgs): LazySelectionSceneObject {
    return this.forward('capEdges', args);
  }

  edges(...indices: number[]): LazySelectionSceneObject {
    return this.forward('edges', indices);
  }

  /**
   * Forward a bucket accessor to the slot's single repeated feature. The
   * result is that feature's own lazy selection — exactly what `e.endEdges()`
   * gives on the original — so filters, indices and scope injection behave
   * identically on every instance.
   */
  private forward(accessor: string, args: unknown[]): LazySelectionSceneObject {
    const roots = this.owner.getInstanceRoots(this.slot);
    const call = `repeat().instance(${this.slot}).${accessor}()`;
    if (roots.length !== 1) {
      throw new Error(
        `${call}: the repeat clones ${roots.length} features per instance, so the accessor is ambiguous — `
        + `repeat one feature per statement, or select through edge().from(r.instance(${this.slot}))`,
      );
    }
    const root = roots[0];
    const fn = (root as unknown as Record<string, unknown>)[accessor];
    if (typeof fn !== 'function') {
      throw new Error(`${call}: the repeated ${root.getType()}() has no ${accessor}() accessor`);
    }
    return (fn as (...a: unknown[]) => LazySelectionSceneObject).apply(root, args);
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const owner = (remap.get(this.owner as unknown as SceneObject) as RepeatBase | undefined) ?? this.owner;
    return new RepeatInstance(this.instanceName, owner, this.slot);
  }
}
