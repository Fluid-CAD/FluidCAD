import { Axis } from "../math/axis.js";
import { SceneObject } from "../common/scene-object.js";
import { IAxis } from "../core/interfaces.js";

export abstract class AxisObjectBase extends SceneObject implements IAxis {

  constructor() {
    super();
  }

  getAxis(): Axis {
    return this.getState('axis') as Axis;
  }

  /**
   * The axis without depending on build state — statement-time consumers
   * (copy duplicate registration runs before any build) resolve through
   * this. The base reads the state like getAxis(); subclasses whose build()
   * computes the axis (AxisFromSketch) override with the computation.
   */
  resolveAxis(): Axis {
    return this.getAxis();
  }

  getType(): string {
    return 'axis';
  }
}
