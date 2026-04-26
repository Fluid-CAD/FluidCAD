import { Point2DLike, isPoint2DLike } from "../../math/point.js";
import { Move } from "../../features/2d/move.js";
import { HorizontalLine } from "../../features/2d/hline.js";
import { normalizePoint2D } from "../../helpers/normalize.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { PlaneObjectBase } from "../../features/plane-renderable-base.js";
import { isPlaneLike, PlaneLike } from "../../math/plane.js";
import { SceneObject } from "../../common/scene-object.js";
import { resolvePlane } from "../../helpers/resolve.js";
import { IHLine, ISceneObject } from "../interfaces.js";

interface HLineFunction {
  /**
   * Draws a horizontal line of the given distance.
   * Chain `.centered()` to center the line on the current position.
   * @param distance - The line length
   */
  (distance: number): IHLine;
  /**
   * Draws a horizontal line from a start point.
   * Chain `.centered()` to center the line on the start point.
   * @param start - The start point
   * @param distance - The line length
   */
  (start: Point2DLike, distance: number): IHLine;
  /**
   * Draws a horizontal line on a specific plane.
   * @param targetPlane - The plane to draw on
   * @param distance - The line length
   */
  (targetPlane: PlaneLike | ISceneObject, distance: number): IHLine;
}

function build(context: SceneParserContext): HLineFunction {
  return function line() {
    let planeObj: PlaneObjectBase | null = null;
    let argOffset = 0;

    // Detect plane as first argument (only valid outside a sketch)
    if (arguments.length > 0) {
      const firstArg = arguments[0];
      if (isPlaneLike(firstArg) || (firstArg instanceof SceneObject && !isPoint2DLike(firstArg))) {
        if (context.getActiveSketch() !== null) {
          throw new Error("hLine(plane, ...) cannot be used inside a sketch. Use hLine(...) instead.");
        }
        planeObj = resolvePlane(firstArg, context);
        argOffset = 1;
      }
    }

    if (argOffset === 0 && typeof arguments[0] !== 'number') {
      // hline(start, distance)
      const start = normalizePoint2D(arguments[0]);
      const distance: number = arguments[1];
      const hline = new HorizontalLine(distance, planeObj);
      context.addSceneObjects([new Move(start), hline]);
      return hline;
    }

    const distance: number = arguments[argOffset];

    const hline = new HorizontalLine(distance, planeObj);
    context.addSceneObject(hline);

    return hline;
  } as HLineFunction
}

export default registerBuilder(build);
