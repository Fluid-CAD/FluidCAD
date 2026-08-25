import { Shape } from "../common/shape.js";
import { Edge } from "../common/edge.js";
import { GeometrySceneObject } from "./2d/geometry.js";
import { LazySelectionSceneObject } from "./lazy-scene-object.js";

/**
 * Shared grid-slot bookkeeping for the 2D copies. A copy owns only the
 * duplicates it stamps — the source geometries keep their own shapes (the
 * copy never strips them), so a copied solved entity stays independently
 * pickable, draggable and constrainable. The grid-slot map still spans
 * EVERY slot, original included: `instance(i)` selects the whole block at
 * grid slot `i` — resolving the original's slot through its source
 * statement's live shapes — a closed region wherever the source was one.
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
   * The still-live real edges of grid slot `index`, in build order. Duplicate
   * slots resolve through the copy's own getShapes(); the original's slot
   * through its source statements' (scope-less reads, so edges hard-consumed
   * by downstream ops drop out of both).
   */
  getInstanceEdges(index: number): Edge[] {
    const instances = this.instanceByShape;
    if (!instances) {
      return [];
    }
    const live = new Set<Shape>(this.getShapes());
    for (const sibling of this.sketch.getPreviousSiblings(this)) {
      for (const shape of sibling.getShapes()) {
        live.add(shape);
      }
    }
    const edges: Edge[] = [];
    for (const [shape, slot] of instances) {
      if (slot === index && shape instanceof Edge && live.has(shape)) {
        edges.push(shape);
      }
    }
    return edges;
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
