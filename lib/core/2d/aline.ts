import { Point2DLike, isPoint2DLike } from "../../math/point.js";
import { AngledLine } from "../../features/2d/aline.js";
import { Move } from "../../features/2d/move.js";
import { normalizePoint2D } from "../../helpers/normalize.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { SceneObject } from "../../common/scene-object.js";
import { IALine, ISceneObject } from "../interfaces.js";
import { type NumberParam, resolveParam } from "../param.js";

interface ALineFunction {
  /**
   * Draws a line at the given angle with the given length. The angle is
   * measured from the previous segment's direction.
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
  /**
   * Draws a line from a start point at the given angle with the given length.
   * The angle is absolute — measured from the positive X axis.
   * @param start - The start point
   * @param angle - The angle in degrees
   * @param length - The line length
   */
  (start: Point2DLike, angle: NumberParam, length: NumberParam): IALine;
  /**
   * Draws a line from a start point at the given angle that ends where it
   * intersects the target geometry. The angle is absolute — measured from the
   * positive X axis.
   * @param start - The start point
   * @param angle - The angle in degrees
   * @param target - The geometry to intersect with
   */
  (start: Point2DLike, angle: NumberParam, target: ISceneObject): IALine;
}

function build(context: SceneParserContext): ALineFunction {
  return function line() {
    if (arguments.length >= 3 && isPoint2DLike(arguments[0])) {
      // aLine(start, angle, length | target) — like line(start, end), the
      // start rides as a Move so the segment itself stays chain-shaped.
      const start = normalizePoint2D(arguments[0]);
      const angle: number = resolveParam(arguments[1] as NumberParam);
      const third = arguments[2];
      const lengthOrTarget: number | SceneObject = third instanceof SceneObject
        ? third
        : resolveParam(third as NumberParam);

      const aline = new AngledLine(angle, lengthOrTarget, null);
      aline.setHasExplicitStart();
      context.addSceneObjects([new Move(start), aline]);
      return aline;
    }

    const angle: number = resolveParam(arguments[0] as NumberParam);
    const second = arguments[1];
    const lengthOrTarget: number | SceneObject = second instanceof SceneObject
      ? second
      : resolveParam(second as NumberParam);

    const aline = new AngledLine(angle, lengthOrTarget, null);
    context.addSceneObject(aline);

    return aline;
  } as ALineFunction;
}

export default registerBuilder(build);
