import { Point2DLike, isPoint2DLike } from "../../math/point.js";
import { Move } from "../../features/2d/move.js";
import { Rect } from "../../features/2d/rect.js";
import { normalizePoint2D } from "../../helpers/normalize.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { isPlaneLike, PlaneLike } from "../../math/plane.js";
import { SceneObject } from "../../common/scene-object.js";
import { resolvePlane } from "../../helpers/resolve.js";
import { IRect, ISceneObject } from "../interfaces.js";

interface RectFunction {
  /**
   * Draws a rectangle with the given width and optional height.
   * @param width - The rectangle width
   * @param height - The rectangle height (defaults to width)
   */
  (width: number, height?: number): IRect;
  /**
   * Draws a rectangle at a given start point.
   * @param start - The start point (bottom-left corner)
   * @param width - The rectangle width
   * @param height - The rectangle height (defaults to width)
   */
  (start: Point2DLike, width: number, height?: number): IRect;
  /**
   * Draws a rectangle with given dimensions on a specific plane.
   * @param targetPlane - The plane to draw on
   * @param width - The rectangle width
   * @param height - The rectangle height
   */
  (targetPlane: PlaneLike | ISceneObject, width: number, height: number): IRect;
}

function build(context: SceneParserContext): RectFunction {
  return function cRect() {
    // Detect plane as first argument (only valid outside a sketch)
    if (arguments.length > 0) {
      const firstArg = arguments[0];
      if (isPlaneLike(firstArg) || (firstArg instanceof SceneObject && !isPoint2DLike(firstArg))) {
        if (context.getActiveSketch() !== null) {
          throw new Error("rect(plane, ...) cannot be used inside a sketch. Use rect(...) instead.");
        }
        const planeObj = resolvePlane(firstArg, context);
        const width = arguments[1] as number;
        const height = arguments[2] as number;
        const rect = new Rect(width, height, planeObj);
        context.addSceneObject(rect);
        return rect;
      }
    }

    const argCount = arguments.length;

    if (argCount === 1) {
      const width = arguments[0] as number;
      const rect = new Rect(width, width);
      context.addSceneObject(rect);
      return rect;
    }
    else if (argCount === 2) {
      if (typeof arguments[0] === 'number') {
        const width = arguments[0] as number;
        const height = arguments[1] as number;

        const rect = new Rect(width, height);
        context.addSceneObject(rect);
        return rect;
      } else {
        const start = normalizePoint2D(arguments[0]);
        const width = arguments[1] as number;

        const rect = new Rect(width, width);
        context.addSceneObjects([new Move(start), rect]);
        return rect;
      }
    }
    else if (argCount === 3) {
      const start = normalizePoint2D(arguments[0]);
      const width = arguments[1] as number;
      const height = arguments[2] as number;

      const rect = new Rect(width, height);
      context.addSceneObjects([new Move(start), rect]);
      return rect;
    }
  } as RectFunction
}

export default registerBuilder(build);
