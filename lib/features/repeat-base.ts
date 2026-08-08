import { SceneObject } from "../common/scene-object.js";
import { Axis } from "../math/axis.js";
import { AxisObjectBase } from "./axis-renderable-base.js";

export type RepeatAxisSource = Axis | AxisObjectBase;

/**
 * Shared base for every `repeat()` kind — linear, circular, mirror and the
 * matrix/rotate form. It fixes what they present in common: one timeline row
 * labelled "Repeat" (the kind lives in the statement, not the row) with the
 * generated instances folded away.
 *
 * It also holds structural equality helpers used by `compareTo`, which runs
 * during cache-compare — before any render — when an `AxisObjectBase` source
 * may not yet have its resolved `Axis` state. Comparing via `getAxis()` at
 * that point would NPE.
 */
export abstract class RepeatBase extends SceneObject {
  override hidesChildren(): boolean {
    return true;
  }

  override getDisplayType(): string {
    return "Repeat";
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
