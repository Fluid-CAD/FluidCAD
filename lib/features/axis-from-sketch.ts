import { AxisTransformOptions, StandardAxis } from "../math/axis.js";
import { AxisObjectBase } from "./axis-renderable-base.js";
import { EdgeOps } from "../oc/edge-ops.js";
import { SceneObject } from "../common/scene-object.js";
import { Sketch } from "./2d/sketch.js";

export class AxisFromSketch extends AxisObjectBase {

  constructor(
    private sketch: Sketch,
    private _direction: StandardAxis,
    private _options?: AxisTransformOptions) {
    super();
  }

  /** The sketch-plane direction this axis stands for ('x' | 'y'). */
  get direction(): StandardAxis {
    return this._direction;
  }

  /** The chained transform options, if any — an offset/rotated axis is
   * no longer the datum line itself. */
  get options(): AxisTransformOptions | undefined {
    return this._options;
  }

  override resolveAxis() {
    const plane = this.sketch.getPlane();
    let axis = plane.normalizeAxis(this._direction);
    if (!axis) {
      throw new Error(`AxisFromSketch: invalid direction '${this._direction}'`);
    }

    if (this._options) {
      axis = axis.transform(this._options);
    }

    return axis;
  }

  build() {
    const axis = this.resolveAxis();
    this.setState('axis', axis);

    const edge = EdgeOps.axisToEdge(axis);
    edge.markAsMetaShape();
    this.addShape(edge);
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const sketch = (remap.get(this.sketch) as Sketch) || this.sketch;
    return new AxisFromSketch(sketch, this._direction, this._options);
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

    if (this._direction !== other.direction) {
      return false;
    }

    if (JSON.stringify(this._options) !== JSON.stringify(other.options)) {
      return false;
    }

    return true;
  }

  getUniqueType(): string {
    return 'axis-from-sketch';
  }

  serialize() {
    return {
      direction: this._direction,
      options: this._options,
    }
  }
}
