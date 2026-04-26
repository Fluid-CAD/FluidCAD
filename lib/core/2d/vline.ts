import { Point2DLike, isPoint2DLike } from "../../math/point.js";
import { Move } from "../../features/2d/move.js";
import { VerticalLine } from "../../features/2d/vline.js";
import { normalizePoint2D } from "../../helpers/normalize.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { PlaneObjectBase } from "../../features/plane-renderable-base.js";
import { isPlaneLike, PlaneLike } from "../../math/plane.js";
import { SceneObject } from "../../common/scene-object.js";
import { resolvePlane } from "../../helpers/resolve.js";
import { IVLine, ISceneObject } from "../interfaces.js";

interface VLineFunction {
  /**
   * Draws a vertical line of the given distance.
   * Chain `.centered()` to center the line on the current position.
   * @param distance - The line length
   */
  (distance: number): IVLine;
  /**
   * Draws a vertical line from a start point.
   * Chain `.centered()` to center the line on the start point.
   * @param start - The start point
   * @param distance - The line length
   */
  (start: Point2DLike, distance: number): IVLine;
  /**
   * Draws a vertical line on a specific plane.
   * @param targetPlane - The plane to draw on
   * @param distance - The line length
   */
  (targetPlane: PlaneLike | ISceneObject, distance: number): IVLine;
}

function build(context: SceneParserContext): VLineFunction {
  return function line() {
    let planeObj: PlaneObjectBase | null = null;
    let argOffset = 0;

    // Detect plane as first argument (only valid outside a sketch)
    if (arguments.length > 0) {
      const firstArg = arguments[0];
      if (isPlaneLike(firstArg) || (firstArg instanceof SceneObject && !isPoint2DLike(firstArg))) {
        if (context.getActiveSketch() !== null) {
          throw new Error("vLine(plane, ...) cannot be used inside a sketch. Use vLine(...) instead.");
        }
        planeObj = resolvePlane(firstArg, context);
        argOffset = 1;
      }
    }

    if (argOffset === 0 && typeof arguments[0] !== 'number') {
      // vline(start, distance)
      const start = normalizePoint2D(arguments[0]);
      const distance: number = arguments[1];
      const vline = new VerticalLine(distance, planeObj);
      context.addSceneObjects([new Move(start), vline]);
      return vline;
    }

    const distance: number = arguments[argOffset];

    const vline = new VerticalLine(distance, planeObj);
    context.addSceneObject(vline);

    return vline;
  } as VLineFunction
}

export default registerBuilder(build);
