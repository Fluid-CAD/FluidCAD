import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Shape } from "../common/shape.js";
import { Axis } from "../math/axis.js";
import { ShapeOps } from "../oc/shape-ops.js";
import { AxisObjectBase } from "./axis-renderable-base.js";
import type { CopySlot, CopySlotLayout } from "./copy-layout.js";

/** An axis a copy can follow: a concrete Axis or a scene-resident axis object. */
export type CopyAxisSource = Axis | AxisObjectBase;

/**
 * Shared base for the 3D copy features. A copy takes the shapes its targets
 * hold and adds one moved clone of them per slot of its layout — the slots
 * `CopyLayout` numbers from the statement's axes and options.
 *
 * Also holds axis-source equality for `compareTo`, which runs during
 * cache-compare — before any render — when an `AxisObjectBase` source may not
 * yet have its resolved `Axis` state. The slot moves read the axis lazily, at
 * build time, safe because an axis object is always added to the scene (and
 * thus built) before the copy that consumes it.
 */
export abstract class CopyBase extends SceneObject {

  /** Explicit targets, or null for the target-less "copy everything before me" form. */
  abstract targetObjects: SceneObject[] | null;

  /**
   * The statement's slots. Safe at parse time: counts resolve from the
   * options, and each slot's move stays lazy until build.
   */
  abstract slotLayout(): CopySlotLayout;

  build(context: BuildSceneObjectContext) {
    const objects = this.targetObjects ?? context.getActiveSceneObjects();

    const originalShapes = objects.flatMap(obj => obj.getShapes());
    for (const obj of objects) {
      obj.removeShapes(this);
    }
    for (const shape of originalShapes) {
      this.addShape(shape);
    }

    this.stampSlots(originalShapes, this.slotLayout().slots);
  }

  /** One moved clone of every original shape per slot, in slot order. */
  private stampSlots(originalShapes: Shape[], slots: CopySlot[]): void {
    for (const { matrix } of slots) {
      const placement = matrix.resolve();
      for (const shape of originalShapes) {
        const transformed = ShapeOps.transform(shape, placement);
        transformed.setMeshSource(shape, placement);
        this.addShape(transformed);
      }
    }
  }

  protected static axisSourceEquals(a: CopyAxisSource, b: CopyAxisSource): boolean {
    const aObj = a instanceof AxisObjectBase;
    const bObj = b instanceof AxisObjectBase;
    if (aObj !== bObj) {
      return false;
    }
    if (aObj) {
      return a.compareTo(b as AxisObjectBase);
    }
    return (a as Axis).equals(b as Axis);
  }

  getDisplayType(): string {
    return "Copy";
  }
}
