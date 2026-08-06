import { Shape } from "../common/shape.js";
import { Edge } from "../common/edge.js";
import { GeometrySceneObject } from "./2d/geometry.js";
import { LazySelectionSceneObject } from "./lazy-scene-object.js";

/**
 * Shared grid-slot bookkeeping for the 2D copies. A copy owns every edge it
 * renders — build strips the source geometries and re-owns their shapes as
 * the original block, then stamps one transformed block per grid position —
 * so the owner alone cannot name ONE copied geometry. `instance(i)` can: it
 * selects the whole block at grid slot `i`, a closed region wherever the
 * source was one, usable as a boolean operand (`fuse(cp.instance(0),
 * cp.instance(3))`).
 *
 * Slot numbering: linear copies linearize the grid in axis order (the first
 * axis varies slowest), the original occupying its own slot (0 when not
 * centered, the center slot when centered); circular copies count rotation
 * steps with the original at 0 — the same numbering their `skip` option uses.
 */
export abstract class Copy2DBase extends GeometrySceneObject {

  /**
   * The shape→slot map rides the STATE map, not an instance field: when
   * SceneCompare reuses an unchanged copy statement across renders, the new
   * object skips build() and serves the old object's transferred state — an
   * instance field would arrive empty and instance() would silently resolve
   * to nothing until a full recompute.
   */
  private get instanceByShape(): Map<Shape, number> | undefined {
    return this.getState('copy-instances');
  }

  /** Build-derived state — every build() starts from an empty map. */
  protected resetInstances(): void {
    this.setState('copy-instances', new Map<Shape, number>());
  }

  /** Stamp `shape` as part of grid slot `index` (build-time only). */
  protected recordInstanceShape(shape: Shape, index: number): void {
    this.instanceByShape!.set(shape, index);
  }

  /** The grid slot a shape was stamped into, or null for foreign shapes. */
  getInstanceIndex(shape: Shape): number | null {
    return this.instanceByShape?.get(shape) ?? null;
  }

  /**
   * The still-owned real edges of grid slot `index`, in build order. Resolved
   * through getShapes() so edges consumed by downstream ops drop out.
   */
  getInstanceEdges(index: number): Edge[] {
    const instances = this.instanceByShape;
    if (!instances) {
      return [];
    }
    return this.getShapes().filter((s): s is Edge =>
      s instanceof Edge && instances.get(s) === index);
  }

  /**
   * One grid slot of the copy as a lazy selection — the whole copied geometry
   * at that position, for ops that take whole-geometry operands.
   */
  instance(index: number): LazySelectionSceneObject {
    return new LazySelectionSceneObject(this.generateUniqueName(`instance-${index}`), (parent) => {
      return (parent as Copy2DBase).getInstanceEdges(index);
    }, this);
  }
}
