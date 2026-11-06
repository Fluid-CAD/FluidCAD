import { Axis, AxisTransformOptions } from "../math/axis.js";
import { SceneObject } from "../common/scene-object.js";
import { AxisObjectBase } from "./axis-renderable-base.js";
import { Connector } from "./connector.js";
import { ConnectorAxis } from "./connector-axis.js";

/**
 * An axis that is a connector's Z axis through its origin ({@link
 * ConnectorAxis}), as a scene object — what a statement holds when it is
 * handed a connector where its axis goes: `revolve(bolt, s)`,
 * `rotate(bolt.instance(1), 30, f)`, `helix(bolt)`, `repeat('circular', bolt,
 * …)`, a custom feature's axis value. Those make it {@link inline}: internal
 * (no timeline row) and drawn nowhere, the connector's own gizmo being what
 * the axis looks like. `axis(bolt)` makes a visible one, a dashed line like
 * any `axis()` statement, which may carry offsets and rotations.
 *
 * The axis is read off the connector's frame whenever it is asked for, so it
 * is where the connector stands when its consumer builds — the connector is
 * declared, and so built, before any statement that names it.
 */
export class AxisFromConnector extends AxisObjectBase {

  constructor(readonly connector: Connector, readonly options?: AxisTransformOptions) {
    super();
  }

  /**
   * The axis a statement makes of a connector argument: internal, so it
   * serves that statement alone, as the plane `sketch('xy', …)` makes does.
   */
  static inline(connector: Connector): AxisFromConnector {
    const axis = new AxisFromConnector(connector);
    axis.markInternal();
    return axis;
  }

  override getAxis(): Axis {
    const axis = ConnectorAxis.axisOf(this.connector);
    return this.options ? axis.transform(this.options) : axis;
  }

  build() {
    const axis = this.getAxis();
    this.setState('axis', axis);
    if (!this.isInternal()) {
      this.addAxisEdge(axis);
    }
  }

  /** Built after its connector — and a repeat never copies the connector it reads. */
  override getDependencies(): SceneObject[] {
    return [this.connector];
  }

  override getCloneDependencies(): SceneObject[] {
    return [];
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const connector = remap.get(this.connector);
    const copy = new AxisFromConnector(connector instanceof Connector ? connector : this.connector, this.options);
    if (this.isInternal()) {
      copy.markInternal();
    }
    return copy;
  }

  compareTo(other: AxisFromConnector): boolean {
    if (!(other instanceof AxisFromConnector)) {
      return false;
    }
    if (!super.compareTo(other)) {
      return false;
    }
    if (this.isInternal() !== other.isInternal()) {
      return false;
    }
    if (!this.connector.compareTo(other.connector)) {
      return false;
    }
    return JSON.stringify(this.options) === JSON.stringify(other.options);
  }

  getUniqueType(): string {
    return 'axis-from-connector';
  }

  serialize() {
    return {
      connector: this.connector.label(),
      options: this.options,
    };
  }
}
