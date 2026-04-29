import { Axis, AxisTransformOptions } from "../math/axis.js";
import { SelectSceneObject } from "./select.js";
import { AxisObjectBase } from "./axis-renderable-base.js";
import { EdgeOps } from "../oc/edge-ops.js";
import { Edge } from "../common/edge.js";
import { SceneObject } from "../common/scene-object.js";
import { requireShapes } from "../common/operand-check.js";

export class AxisFromEdge extends AxisObjectBase {

  constructor(private sourceObject: SceneObject, private options?: AxisTransformOptions) {
    super();
  }

  override validate() {
    // AxisObjectBase sources expose the axis directly — no shapes required.
    if (this.sourceObject instanceof AxisObjectBase) {
      return;
    }
    requireShapes(this.sourceObject, "source", "axis");
  }

  build() {
    let axis: Axis;
    if (this.sourceObject instanceof SelectSceneObject) {
      const shapes = this.sourceObject.getShapes({ excludeGuide: false });
      console.log(`Axis: Retrieved ${shapes.length} shapes from selection`);
      if (shapes.length === 0) {
        throw new Error("Axis: Selected object has no shapes to extract axis from");
      }

      if (shapes.length > 1) {
        throw new Error("Axis: Selected object has multiple shapes; cannot determine axis");
      }

      const shape: Edge = shapes[0] as Edge;

      if (!shape.isEdge()) {
        throw new Error("Axis: Selected shape is not an edge; cannot extract axis: " + shape.getType());
      }

      for (const s of shapes) {
        this.sourceObject.removeShape(s, this);
      }

      axis = EdgeOps.edgeToAxis(shape);
    }
    else if (this.sourceObject instanceof AxisObjectBase) {
      axis = this.sourceObject.getAxis();
    }
    else if (this.sourceObject instanceof SceneObject) {
      const shapes = this.sourceObject.getShapes({ excludeGuide: false });
      console.log(`Axis: Retrieved ${shapes.length} shapes from source object`);
      if (shapes.length === 0) {
        throw new Error("Axis: Source object has no shapes to extract axis from");
      }

      if (shapes.length > 1) {
        throw new Error("Axis: Source object has multiple shapes; cannot determine axis");
      }

      const shape: Edge = shapes[0] as Edge;

      if (!shape.isEdge()) {
        throw new Error("Axis: Source shape is not an edge; cannot extract axis: " + shape.getType());
      }

      axis = EdgeOps.edgeToAxis(shape);
    }

    if (this.options) {
      axis = axis.transform(this.options);
    }

    this.setState('axis', axis);

    const edge = EdgeOps.axisToEdge(axis);

    this.addShape(edge);
  }

  compareTo(other: AxisFromEdge): boolean {
    if (!(other instanceof AxisFromEdge)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    if (!this.sourceObject.compareTo(other.sourceObject)) {
      return false;
    }

    if (JSON.stringify(this.options) !== JSON.stringify(other.options)) {
      return false;
    }

    return true;
  }

  getUniqueType(): string {
    return 'axis-from-edge';
  }

  serialize() {
    return {
      selection: this.sourceObject.serialize(),
      options: this.options,
    }
  }
}
