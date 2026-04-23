import { AxisTransformOptions, StandardAxis } from "../math/axis.js";
import { AxisObjectBase } from "./axis-renderable-base.js";
import { EdgeOps } from "../oc/edge-ops.js";
import { SceneObject } from "../common/scene-object.js";
import { Sketch } from "./2d/sketch.js";

export class AxisFromSketch extends AxisObjectBase {

  constructor(
    private sketch: Sketch,
    private direction: StandardAxis,
    private options?: AxisTransformOptions) {
    super();
  }

  build() {
    const plane = this.sketch.getPlane();
    let axis = plane.normalizeAxis(this.direction);
    if (!axis) {
      throw new Error(`AxisFromSketch: invalid direction '${this.direction}'`);
    }

    if (this.options) {
      axis = axis.transform(this.options);
    }

    this.setState('axis', axis);

    const edge = EdgeOps.axisToEdge(axis);
    edge.markAsMetaShape();
    this.addShape(edge);
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const sketch = (remap.get(this.sketch) as Sketch) || this.sketch;
    return new AxisFromSketch(sketch, this.direction, this.options);
  }

  compareTo(other: AxisFromSketch): boolean {
    if (!(other instanceof AxisFromSketch)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    if (!this.sketch.compareTo(other.sketch)) {
      return false;
    }

    if (this.direction !== other.direction) {
      return false;
    }

    if (JSON.stringify(this.options) !== JSON.stringify(other.options)) {
      return false;
    }

    return true;
  }

  getUniqueType(): string {
    return 'axis-from-sketch';
  }

  serialize() {
    return {
      direction: this.direction,
      options: this.options,
    }
  }
}
