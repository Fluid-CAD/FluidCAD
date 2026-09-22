import { Axis } from "../math/axis.js";
import { SceneObject } from "../common/scene-object.js";
import { IAxis } from "../core/interfaces.js";
import { EdgeOps } from "../oc/edge-ops.js";

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

  /**
   * Emits the axis's display edge. The edge is a meta shape: it renders as
   * the axis line but is never geometry. An axis written inside a sketch
   * callback (`copy('linear', axis(l), …)`) becomes a sketch child, and the
   * sketch's profile read excludes meta shapes — a plain edge would enter
   * the extrude profile as a 600 mm line slicing every region it crosses.
   */
  protected addAxisEdge(axis: Axis): void {
    const edge = EdgeOps.axisToEdge(axis);
    edge.markAsMetaShape();
    this.addShape(edge);
  }
}
