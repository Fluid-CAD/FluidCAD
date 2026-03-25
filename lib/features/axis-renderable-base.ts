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

  getType(): string {
    return 'axis';
  }
}
