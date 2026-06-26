import { Point2DLike, isPoint2DLike } from "../../math/point.js";
import { Move } from "../../features/2d/move.js";
import { VerticalLine } from "../../features/2d/vline.js";
import { normalizePoint2D } from "../../helpers/normalize.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { SceneObject } from "../../common/scene-object.js";
import { IVLine, ISceneObject } from "../interfaces.js";
import { type NumberParam, isNumberParam, resolveParam } from "../param.js";

interface VLineFunction {
  /**
   * Draws a vertical line of the given distance.
   * Chain `.centered()` to center the line on the current position.
   * @param distance - The line length
   */
  (distance: NumberParam): IVLine;
  /**
   * Draws a vertical line that ends where it intersects the target geometry.
   * The nearest intersection (in either direction along the Y axis) is used.
   * @param target - The geometry to intersect with
   */
  (target: ISceneObject): IVLine;
  /**
   * Draws a vertical line from a start point.
   * Chain `.centered()` to center the line on the start point.
   * @param start - The start point
   * @param distance - The line length
   */
  (start: Point2DLike, distance: NumberParam): IVLine;
  /**
   * Draws a vertical line from a start point that ends where it intersects
   * the target geometry. The nearest intersection (in either direction along
   * the Y axis) is used.
   * @param start - The start point
   * @param target - The geometry to intersect with
   */
  (start: Point2DLike, target: ISceneObject): IVLine;
}

function build(context: SceneParserContext): VLineFunction {
  return function line() {
    const inSketch = context.getActiveSketch() !== null;

    if (inSketch && arguments[0] instanceof SceneObject && !isPoint2DLike(arguments[0])) {
      // vLine(target)
      const vline = new VerticalLine(arguments[0] as SceneObject, null);
      context.addSceneObject(vline);
      return vline;
    }

    if (!isNumberParam(arguments[0])) {
      // vLine(start, distance) or vLine(start, target)
      const start = normalizePoint2D(arguments[0]);
      const second = arguments[1];
      const distanceOrTarget: number | SceneObject = second instanceof SceneObject
        ? second
        : resolveParam(second as NumberParam);
      const vline = new VerticalLine(distanceOrTarget, null);
      vline.setHasExplicitStart();
      context.addSceneObjects([new Move(start), vline]);
      return vline;
    }

    const distance: number = resolveParam(arguments[0] as NumberParam);

    const vline = new VerticalLine(distance, null);
    context.addSceneObject(vline);

    return vline;
  } as VLineFunction
}

export default registerBuilder(build);
