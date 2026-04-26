import { Point2DLike, isPoint2DLike } from "../../math/point.js";
import { Move } from "../../features/2d/move.js";
import { HorizontalLine } from "../../features/2d/hline.js";
import { normalizePoint2D } from "../../helpers/normalize.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { PlaneObjectBase } from "../../features/plane-renderable-base.js";
import { isPlaneLike, PlaneLike } from "../../math/plane.js";
import { SceneObject } from "../../common/scene-object.js";
import { resolvePlane } from "../../helpers/resolve.js";
import { IGeometry, ISceneObject } from "../interfaces.js";

interface HLineFunction {
  /**
   * Draws a horizontal line of the given distance.
   * @param distance - The line length
   * @param centered - Whether to center the line on the current position
   */
  (distance: number, centered?: boolean): IGeometry;
  /**
   * Draws a horizontal line from a start point.
   * @param start - The start point
   * @param distance - The line length
   * @param centered - Whether to center the line on the start point
   */
  (start: Point2DLike, distance: number, centered?: boolean): IGeometry;
  /**
   * Draws a horizontal line on a specific plane.
   * @param targetPlane - The plane to draw on
   * @param distance - The line length
   */
  (targetPlane: PlaneLike | ISceneObject, distance: number): IGeometry;
  /**
   * Draws a horizontal line with centering on a specific plane.
   * @param targetPlane - The plane to draw on
   * @param distance - The line length
   * @param centered - Whether to center the line on the current position
   */
  (targetPlane: PlaneLike | ISceneObject, distance: number, centered: boolean): IGeometry;
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

    const argCount = arguments.length - argOffset;

    if (argOffset === 0 && typeof arguments[0] !== 'number') {
      // hline(start, distance) or hline(start, distance, centered)
      const start = normalizePoint2D(arguments[0]);
      const distance: number = arguments[1];
      const centered = argCount >= 3 ? (arguments[2] as boolean) : false;
      const hline = new HorizontalLine(distance, centered, planeObj);
      context.addSceneObjects([new Move(start), hline]);
      return hline;
    }

    const distance: number = arguments[argOffset];
    const centered = argCount >= 2 ? (arguments[argOffset + 1] as boolean) : false;

    const hline = new HorizontalLine(distance, centered, planeObj);
    context.addSceneObject(hline);

    return hline;
  } as HLineFunction
}

export default registerBuilder(build);
