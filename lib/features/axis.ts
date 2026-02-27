import { Axis, AxisTransformOptions } from "../math/axis.js";
import { AxisObjectBase } from "./axis-renderable-base.js";
import { EdgeOps } from "../oc/edge-ops.js";

export class AxisObject extends AxisObjectBase {

  constructor(public axis: Axis, private options?: AxisTransformOptions) {
    super();

    let a = this.axis;

    if (this.options) {
      a = a.transform(this.options);
    }

    this.setState('axis', a);
  }

  build() {
    const edge = EdgeOps.axisToEdge(this.getAxis());
    edge.markAsMetaShape();
    this.addShape(edge);
  }

  compareTo(other: AxisObject): boolean {
    if (!(other instanceof AxisObject)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    if (!this.axis.equals(other.axis)) {
      return false;
    }

    if (JSON.stringify(this.options) !== JSON.stringify(other.options)) {
      return false;
    }

    return true;
  }

  serialize() {
    return {
      origin: this.axis.origin,
      direction: this.axis.direction,
      options: this.options
    }
  }
}
