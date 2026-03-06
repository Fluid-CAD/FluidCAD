import { Axis, AxisTransformOptions } from "../math/axis.js";
import { AxisObjectBase } from "./axis-renderable-base.js";
import { EdgeOps } from "../oc/edge-ops.js";

export class AxisMiddle extends AxisObjectBase {

  constructor(public axis1: AxisObjectBase, public axis2: AxisObjectBase, private options?: AxisTransformOptions) {
    super();
  }

  build() {
    let axis1 = this.axis1.getAxis();

    let axis2 = this.axis2.getAxis()

    console.log("AxisMiddle: Retrieved axes:", axis1, axis2);

    const parallel = axis1.isParallelTo(axis2);

    if (!parallel) {
      throw new Error("AxisMiddleRenderable: The two axes are not parallel; cannot define a middle axis");
    }

    const middlePoint = axis1.origin.add(axis2.origin).multiplyScalar(0.5);
    let middleAxis = new Axis(middlePoint, axis1.direction);

    if (this.options) {
      middleAxis = middleAxis.transform(this.options);
    }

    this.setState('axis', middleAxis);

    const edge = EdgeOps.axisToEdge(middleAxis);

    this.addShape(edge);
  }

  compareTo(other: AxisMiddle): boolean {
    if (!(other instanceof AxisMiddle)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    if (!this.axis1.compareTo(other.axis1)) {
      return false;
    }

    if (!this.axis2.compareTo(other.axis2)) {
      return false;
    }

    if (JSON.stringify(this.options) !== JSON.stringify(other.options)) {
      return false;
    }

    return true;
  }

  getUniqueType(): string {
    return 'axis-middle';
  }

  serialize() {
    return {
      axis1: this.axis1.serialize(),
      axis2: this.axis2.serialize(),
      options: this.options
    }
  }
}
