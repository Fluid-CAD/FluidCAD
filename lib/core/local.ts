import { registerBuilder, SceneParserContext } from "../index.js";
import { AxisFromSketch } from "../features/axis-from-sketch.js";
import { isStandardAxis, StandardAxis } from "../math/axis.js";
import { IAxis } from "./interfaces.js";

interface LocalFunction {
  /**
   * Creates an axis in the active sketch's local coordinate system.
   * @param axis - One of the standard axes ('x', 'y', 'z') to interpret
   *   relative to the active sketch's plane.
   */
  (axis: StandardAxis): IAxis;
}

function build(context: SceneParserContext): LocalFunction {
  return function local(axis: StandardAxis): IAxis {
    if (!isStandardAxis(axis)) {
      throw new Error("local() accepts only 'x', 'y', or 'z'");
    }

    const sketch = context.getActiveSketch();
    if (!sketch) {
      throw new Error("local() can only be used inside a sketch");
    }

    const ax = new AxisFromSketch(sketch, axis);
    context.addSceneObject(ax);
    return ax;
  };
}

export default registerBuilder(build);
