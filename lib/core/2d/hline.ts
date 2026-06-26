import { Point2DLike, isPoint2DLike } from "../../math/point.js";
import { Move } from "../../features/2d/move.js";
import { HorizontalLine } from "../../features/2d/hline.js";
import { normalizePoint2D } from "../../helpers/normalize.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { SceneObject } from "../../common/scene-object.js";
import { IHLine, ISceneObject } from "../interfaces.js";
import { type NumberParam, isNumberParam, resolveParam } from "../param.js";

interface HLineFunction {
  /**
   * Draws a horizontal line of the given distance.
   * Chain `.centered()` to center the line on the current position.
   * @param distance - The line length
   */
  (distance: NumberParam): IHLine;
  /**
   * Draws a horizontal line that ends where it intersects the target geometry.
   * The nearest intersection (in either direction along the X axis) is used.
   * @param target - The geometry to intersect with
   */
  (target: ISceneObject): IHLine;
  /**
   * Draws a horizontal line from a start point.
   * Chain `.centered()` to center the line on the start point.
   * @param start - The start point
   * @param distance - The line length
   */
  (start: Point2DLike, distance: NumberParam): IHLine;
  /**
   * Draws a horizontal line from a start point that ends where it intersects
   * the target geometry. The nearest intersection (in either direction along
   * the X axis) is used.
   * @param start - The start point
   * @param target - The geometry to intersect with
   */
  (start: Point2DLike, target: ISceneObject): IHLine;
}

function build(context: SceneParserContext): HLineFunction {
  return function line() {
    const inSketch = context.getActiveSketch() !== null;

    if (inSketch && arguments[0] instanceof SceneObject && !isPoint2DLike(arguments[0])) {
      // hLine(target)
      const hline = new HorizontalLine(arguments[0] as SceneObject, null);
      context.addSceneObject(hline);
      return hline;
    }

    if (!isNumberParam(arguments[0])) {
      // hLine(start, distance) or hLine(start, target)
      const start = normalizePoint2D(arguments[0]);
      const second = arguments[1];
      const distanceOrTarget: number | SceneObject = second instanceof SceneObject
        ? second
        : resolveParam(second as NumberParam);
      const hline = new HorizontalLine(distanceOrTarget, null);
      hline.setHasExplicitStart();
      context.addSceneObjects([new Move(start), hline]);
      return hline;
    }

    const distance: number = resolveParam(arguments[0] as NumberParam);

    const hline = new HorizontalLine(distance, null);
    context.addSceneObject(hline);

    return hline;
  } as HLineFunction
}

export default registerBuilder(build);
