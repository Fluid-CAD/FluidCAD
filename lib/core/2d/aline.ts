import { AngledLine } from "../../features/2d/aline.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { SceneObject } from "../../common/scene-object.js";
import { IALine, ISceneObject } from "../interfaces.js";
import { type NumberParam, resolveParam } from "../param.js";

interface ALineFunction {
  /**
   * Draws a line at the given angle with the given length.
   * Chain `.centered()` to center the line on the current position.
   * @param angle - The angle in degrees
   * @param length - The line length
   */
  (angle: NumberParam, length: NumberParam): IALine;
  /**
   * Draws a line at the given angle that ends where it intersects the target
   * geometry. The nearest intersection along the line's direction (in either
   * sign) is used.
   * @param angle - The angle in degrees
   * @param target - The geometry to intersect with
   */
  (angle: NumberParam, target: ISceneObject): IALine;
}

function build(context: SceneParserContext): ALineFunction {
  return function line() {
    const angle: number = resolveParam(arguments[0] as NumberParam);
    const second = arguments[1];
    const lengthOrTarget: number | SceneObject = second instanceof SceneObject
      ? second
      : resolveParam(second as NumberParam);

    const aline = new AngledLine(angle, lengthOrTarget, null);
    context.addSceneObject(aline);

    return aline;
  }
}

export default registerBuilder(build);
