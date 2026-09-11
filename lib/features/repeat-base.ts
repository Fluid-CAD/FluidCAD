import { SceneObject } from "../common/scene-object.js";
import { Axis } from "../math/axis.js";
import { AxisObjectBase } from "./axis-renderable-base.js";
import { RepeatInstance } from "./repeat-instance.js";

export type RepeatAxisSource = Axis | AxisObjectBase;

/**
 * The repeated features at one instance slot: the originals for the
 * original's slot, their root clones elsewhere, or null for a slot the
 * `skip` option left out.
 */
export type RepeatSlot = SceneObject[] | null;

/**
 * Shared base for every `repeat()` kind — linear, circular, mirror and the
 * matrix/rotate form. It fixes what they present in common: one timeline row
 * labelled "Repeat" (the kind lives in the statement, not the row) with the
 * generated instances folded away.
 *
 * It also records the instance slots `instance(k)` addresses. Slot numbering
 * matches the 2D copy's: linear repeats linearize the grid in axis order
 * (the first axis varies slowest) with the original at its own slot — 0 when
 * not centered, the center slot when centered; circular repeats count
 * rotation steps with the original at 0, the numbering `skip` uses; mirror,
 * rotate and matrix repeats have slots 0 (original) and 1 (clone).
 *
 * It also holds structural equality helpers used by `compareTo`, which runs
 * during cache-compare — before any render — when an `AxisObjectBase` source
 * may not yet have its resolved `Axis` state. Comparing via `getAxis()` at
 * that point would NPE.
 */
export abstract class RepeatBase extends SceneObject {

  private _slots: RepeatSlot[] = [];
  private _originalSlot = 0;

  override hidesChildren(): boolean {
    return true;
  }

  override getDisplayType(): string {
    return "Repeat";
  }

  /** Record the per-slot repeated features (parse time, after cloning). */
  setInstanceSlots(slots: RepeatSlot[], originalSlot: number): void {
    this._slots = slots;
    this._originalSlot = originalSlot;
  }

  getInstanceSlots(): readonly RepeatSlot[] {
    return this._slots;
  }

  getOriginalSlot(): number {
    return this._originalSlot;
  }

  /** The slot `feature` was repeated into (originals included), or null. */
  slotOf(feature: SceneObject): number | null {
    for (let i = 0; i < this._slots.length; i++) {
      const roots = this._slots[i];
      if (roots && roots.includes(feature)) {
        return i;
      }
    }
    return null;
  }

  /** The repeated features at `slot`; throws statement-speak for bad slots. */
  getInstanceRoots(slot: number): SceneObject[] {
    const count = this._slots.length;
    if (!Number.isInteger(slot) || slot < 0 || slot >= count) {
      const range = count > 0 ? `0–${count - 1}` : 'none';
      throw new Error(`repeat().instance(${slot}) is out of range — valid slots: ${range}`);
    }
    const roots = this._slots[slot];
    if (!roots) {
      throw new Error(`repeat().instance(${slot}) was skipped by this repeat — it holds no instance`);
    }
    return roots;
  }

  /**
   * One instance of the pattern as a lazy selection — the whole repeated
   * geometry at that slot — which also forwards the repeated feature's
   * bucket accessors (`r.instance(1).endEdges()`) when the slot holds one.
   */
  instance(index: number): RepeatInstance {
    // Validate eagerly so a bad index errors at the statement, not at build.
    this.getInstanceRoots(index);
    return new RepeatInstance(this.generateUniqueName(`instance-${index}`), this, index);
  }

  protected static axisSourceEquals(a: RepeatAxisSource, b: RepeatAxisSource): boolean {
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
}
