import { SceneObject } from "../common/scene-object.js";
import { Axis } from "../math/axis.js";
import { AxisObjectBase } from "./axis-renderable-base.js";

export type RepeatAxisSource = Axis | AxisObjectBase;

/**
 * Shared base for repeat features. Holds structural equality helpers used
 * by `compareTo`, which runs during cache-compare — before any render —
 * when an `AxisObjectBase` source may not yet have its resolved `Axis`
 * state. Comparing via `getAxis()` at that point would NPE.
 */
export abstract class RepeatBase extends SceneObject {
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
