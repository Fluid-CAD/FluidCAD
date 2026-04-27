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
  (start: Point2DLike, distance: number): IHLine;
  /**
   * Draws a horizontal line from a start point that ends where it intersects
   * the target geometry. The nearest intersection (in either direction along
   * the X axis) is used.
   * @param start - The start point
   * @param target - The geometry to intersect with
   */
  (start: Point2DLike, target: ISceneObject): IHLine;
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
    const inSketch = context.getActiveSketch() !== null;

    // Detect plane as first argument (only valid outside a sketch).
    // Inside a sketch, a SceneObject in the first position is a target geometry,
    // and a true PlaneLike is an error since drawing on another plane mid-sketch
    // is not supported.
    if (arguments.length > 0) {
      const firstArg = arguments[0];
      if (isPlaneLike(firstArg)) {
        if (inSketch) {
          throw new Error("hLine(plane, ...) cannot be used inside a sketch. Use hLine(...) instead.");
        }
        planeObj = resolvePlane(firstArg, context);
        argOffset = 1;
      } else if (!inSketch && firstArg instanceof SceneObject && !isPoint2DLike(firstArg)) {
        planeObj = resolvePlane(firstArg, context);
        argOffset = 1;
      }
    }

    if (argOffset === 0 && inSketch && arguments[0] instanceof SceneObject && !isPoint2DLike(arguments[0])) {
      // hLine(target)
      const hline = new HorizontalLine(arguments[0] as SceneObject, null);
      context.addSceneObject(hline);
      return hline;
    }

    if (argOffset === 0 && typeof arguments[0] !== 'number') {
      // hLine(start, distance) or hLine(start, target)
      const start = normalizePoint2D(arguments[0]);
      const second = arguments[1];
      const distanceOrTarget: number | SceneObject = second instanceof SceneObject
        ? second
        : (second as number);
      const hline = new HorizontalLine(distanceOrTarget, planeObj);
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
