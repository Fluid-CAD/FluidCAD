import { SceneObject } from "../common/scene-object.js";
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
 * A repeat can be repeated: as a target it stands for its whole pattern —
 * the originals and every instance it placed (see `patternFeatures`). The
 * repeat of it keeps its own numbering, each slot holding the whole inner
 * pattern at that position.
 *
 * A repeat refuses connector targets: it re-applies features, and a connector
 * is a frame to copy, not a feature to re-apply (see `refuseTargets`).
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

  /**
   * Every feature the repeat placed — its originals and their clones — in
   * slot order, the slots `skip` left out passed over.
   */
  getPatternRoots(): SceneObject[] {
    return this._slots.flatMap(roots => roots ?? []);
  }

  /**
   * The features `targets` stand for when a repeat re-applies them: a repeat
   * among them is its whole pattern ({@link getPatternRoots}), `r.instance(k)`
   * the features at that slot, anything else itself. Each feature is listed
   * once, however often the targets name it — `repeat(…, hole, row)` names
   * the hole twice.
   */
  static patternFeatures(targets: SceneObject[]): SceneObject[] {
    const features = new Set<SceneObject>();
    for (const target of targets) {
      if (target instanceof RepeatBase) {
        target.getPatternRoots().forEach(root => features.add(root));
      } else if (target instanceof RepeatInstance) {
        target.getRoots().forEach(root => features.add(root));
      } else {
        features.add(target);
      }
    }
    return [...features];
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
   * one is a connector, or a repeat that was itself refused. A clone of a
   * connector would rebuild its frame from the seed's already-consumed
   * source, never move, and never register on the part; a refused repeat
   * placed no instances to repeat. Returns whether it refused: the builder
   * then clones nothing, and the repeat's own build reports the refusal on
   * its row (SceneObject.refuse, which also keeps a refused repeat from
   * matching a working one in the cache — a mirror or matrix repeat compares
   * little else).
   */
  refuseTargets(targets: SceneObject[]): boolean {
    const connector = targets.find((target): target is Connector => target instanceof Connector);
    if (connector) {
      this.refuse(`repeat() re-applies features — copy a connector with ${this.connectorCopyAdvice(connector.connectorName)}`);
      return true;
    }
    const refused = targets.some(target => target instanceof RepeatBase && target.getRefusal() !== null);
    if (refused) {
      this.refuse("repeat(): the repeat this one repeats is refused, so it has no instances to repeat — fix that repeat first");
      return true;
    }
    return false;
  }

  /**
   * The copy() calls that copy connector `name` in this repeat's stead. A
   * mirror, rotate or matrix repeat has no copy() of its own shape, so it
   * names the two pattern forms.
   */
  protected connectorCopyAdvice(name: string): string {
    return `copy('linear', axis, options, ${name}) or copy('circular', axis, options, ${name})`;
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
