import { SceneObject } from "../common/scene-object.js";
import { Axis } from "../math/axis.js";
import { AxisObjectBase } from "./axis-renderable-base.js";

/** An axis a copy can follow: a concrete Axis or a scene-resident axis object. */
export type CopyAxisSource = Axis | AxisObjectBase;

/**
 * Shared base for copy features. Holds the axis-source helpers: equality for
 * `compareTo` — which runs during cache-compare, before any render, when an
 * `AxisObjectBase` source may not yet have its resolved `Axis` state — and
 * build-time resolution, safe because an axis object is always added to the
 * scene (and thus built) before the copy that consumes it.
 */
export abstract class CopyBase extends SceneObject {
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

  protected static resolveAxisSource(source: CopyAxisSource): Axis {
    return source instanceof AxisObjectBase ? source.getAxis() : source;
  }

  getDisplayType(): string {
    return "Copy";
  }
}
