import { SceneObject } from "../common/scene-object.js";
import { BuildError } from "../common/build-error.js";
import { Axis } from "../math/axis.js";
import { LazyMatrix } from "../math/lazy-matrix.js";
import { AxisObjectBase } from "./axis-renderable-base.js";
import { Connector } from "./connector.js";
import { RepeatInstance } from "./repeat-instance.js";

export type RepeatAxisSource = Axis | AxisObjectBase;

/**
 * The repeated features at one instance slot: the originals for the
 * original's slot, their root clones elsewhere, or null for a slot the
 * `skip` option left out.
 */
export type RepeatSlot = SceneObject[] | null;

/**
 * The move that places one instance slot: the identity for the original's
 * slot, the transform its clones were made with elsewhere, or null for a slot
 * the `skip` option left out.
 */
export type RepeatSlotMatrix = LazyMatrix | null;

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
 * rotate and matrix repeats have slots 0 (original) and 1 (clone). Each slot
 * also keeps the move that placed it, for whatever has to land where a slot's
 * instance landed without being one of its clones.
 *
 * A repeat refuses connector targets: it re-applies features, and a connector
 * is a frame to copy, not a feature to re-apply (see `refuseConnectorTargets`).
 *
 * It also holds structural equality helpers used by `compareTo`, which runs
 * during cache-compare — before any render — when an `AxisObjectBase` source
 * may not yet have its resolved `Axis` state. Comparing via `getAxis()` at
 * that point would NPE.
 */
export abstract class RepeatBase extends SceneObject {

  private _slots: RepeatSlot[] = [];
  private _slotMatrices: RepeatSlotMatrix[] = [];
  private _originalSlot = 0;
  private _refusal: string | null = null;

  override hidesChildren(): boolean {
    return true;
  }

  override getDisplayType(): string {
    return "Repeat";
  }

  /**
   * Record the per-slot repeated features and the move that placed each
   * (parse time, after cloning) — `matrices` runs parallel to `slots`.
   */
  setInstanceSlots(slots: RepeatSlot[], originalSlot: number, matrices: RepeatSlotMatrix[]): void {
    if (matrices.length !== slots.length) {
      throw new Error(`repeat(): ${slots.length} instance slots recorded with ${matrices.length} matrices`);
    }
    this._slots = slots;
    this._slotMatrices = matrices;
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
    this.assertLiveSlot(slot);
    return this._slots[slot]!;
  }

  /**
   * The move that places `slot` relative to the original — the very
   * transform its clones carry, or the identity for the original's own slot.
   * Lazy, since an axis object may not be built yet; throws statement-speak
   * for bad slots, as `getInstanceRoots` does.
   */
  getSlotMatrix(slot: number): LazyMatrix {
    this.assertLiveSlot(slot);
    return this._slotMatrices[slot]!;
  }

  /** Throws statement-speak for a slot out of range or one `skip` left out. */
  private assertLiveSlot(slot: number): void {
    const count = this._slots.length;
    if (!Number.isInteger(slot) || slot < 0 || slot >= count) {
      const range = count > 0 ? `0–${count - 1}` : 'none';
      throw new Error(`repeat().instance(${slot}) is out of range — valid slots: ${range}`);
    }
    if (!this._slots[slot]) {
      throw new Error(`repeat().instance(${slot}) was skipped by this repeat — it holds no instance`);
    }
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

  /**
   * Refuse `targets` — the explicit ones or the implicit last object — when
   * one is a connector. A clone of a connector would rebuild its frame from
   * the seed's already-consumed source, never move, and never register on the
   * part. Returns whether it refused: the builder then clones nothing, and the
   * repeat's own build reports the refusal on its row.
   */
  refuseConnectorTargets(targets: SceneObject[]): boolean {
    const connector = targets.find((target): target is Connector => target instanceof Connector);
    if (!connector) {
      return false;
    }
    this._refusal = `repeat() re-applies features — copy a connector with ${this.connectorCopyAdvice(connector.connectorName)}`;
    return true;
  }

  /**
   * The copy() calls that copy connector `name` in this repeat's stead. A
   * mirror, rotate or matrix repeat has no copy() of its own shape, so it
   * names the two pattern forms.
   */
  protected connectorCopyAdvice(name: string): string {
    return `copy('linear', axis, options, ${name}) or copy('circular', axis, options, ${name})`;
  }

  override validate(): void {
    if (this._refusal) {
      throw new BuildError(this._refusal);
    }
  }

  override compareTo(other: SceneObject): boolean {
    // A refused repeat never stands in for one that clones, or the reverse:
    // a mirror or matrix repeat compares little else, and a cached match
    // would carry the refusal's error onto a repeat that now builds.
    if (!(other instanceof RepeatBase) || this._refusal !== other._refusal) {
      return false;
    }
    return super.compareTo(other);
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
