import { Point2DLike } from "../../math/point.js";
import { Move } from "../../features/2d/move.js";
import { Rect } from "../../features/2d/rect.js";
import { normalizePoint2D } from "../../helpers/normalize.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { IRect } from "../interfaces.js";
import { type NumberParam, isNumberParam, resolveParam } from "../param.js";

interface RectFunction {
  /**
   * Draws a rectangle with the given width and optional height.
   * @param width - The rectangle width
   * @param height - The rectangle height (defaults to width)
   */
  (width: NumberParam, height?: NumberParam): IRect;
  /**
   * Draws a rectangle at a given start point.
   * @param start - The start point (bottom-left corner)
   * @param width - The rectangle width
   * @param height - The rectangle height (defaults to width)
   */
  (start: Point2DLike, width: NumberParam, height?: NumberParam): IRect;
}

function build(context: SceneParserContext): RectFunction {
  return function cRect() {
    const argCount = arguments.length;

    if (argCount === 1) {
      const width = resolveParam(arguments[0] as NumberParam);
      const rect = new Rect(width, width);
      context.addSceneObject(rect);
      return rect;
    }
    else if (argCount === 2) {
      if (isNumberParam(arguments[0])) {
        const width = resolveParam(arguments[0] as NumberParam);
        const height = resolveParam(arguments[1] as NumberParam);

        const rect = new Rect(width, height);
        context.addSceneObject(rect);
        return rect;
      } else {
        const start = normalizePoint2D(arguments[0]);
        const width = resolveParam(arguments[1] as NumberParam);

        const rect = new Rect(width, width);
        context.addSceneObjects([new Move(start), rect]);
        return rect;
      }
    }
    else if (argCount === 3) {
      const start = normalizePoint2D(arguments[0]);
      const width = resolveParam(arguments[1] as NumberParam);
      const height = resolveParam(arguments[2] as NumberParam);

      const rect = new Rect(width, height);
      context.addSceneObjects([new Move(start), rect]);
      return rect;
    }
  } as RectFunction
}

export default registerBuilder(build);
