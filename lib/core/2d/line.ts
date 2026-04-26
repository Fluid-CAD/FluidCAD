import { Point2DLike, isPoint2DLike } from "../../math/point.js";
import { LineTo } from "../../features/2d/line.js";
import { Move } from "../../features/2d/move.js";
import { normalizePoint2D } from "../../helpers/normalize.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { PlaneObjectBase } from "../../features/plane-renderable-base.js";
import { isPlaneLike, PlaneLike } from "../../math/plane.js";
import { SceneObject } from "../../common/scene-object.js";
import { resolvePlane } from "../../helpers/resolve.js";
import { IGeometry, ISceneObject } from "../interfaces.js";

interface LineFunction {
  /**
   * Draws a line from the current position to the given point.
   * @param end - The end point
   */
  (end: Point2DLike): IGeometry;
  /**
   * Draws a line between two points.
   * @param start - The start point
   * @param end - The end point
   */
  (start: Point2DLike, end: Point2DLike): IGeometry;
  /**
   * Draws a line to the given point on a specific plane.
   * @param targetPlane - The plane to draw on
   * @param end - The end point
   */
  (targetPlane: PlaneLike | ISceneObject, end: Point2DLike): IGeometry;
}

function build(context: SceneParserContext): LineFunction {
  return function line() {
    let line: LineTo;
    let planeObj: PlaneObjectBase | null = null;
    let argOffset = 0;

    // Detect plane as first argument (only valid outside a sketch)
    // Point2DLike is not plane-like so no conflict
    if (arguments.length > 0) {
      const firstArg = arguments[0];
      if (isPlaneLike(firstArg) || (firstArg instanceof SceneObject && !isPoint2DLike(firstArg))) {
        if (context.getActiveSketch() !== null) {
          throw new Error("line(plane, ...) cannot be used inside a sketch. Use line(...) instead.");
        }
        planeObj = resolvePlane(firstArg, context);
        argOffset = 1;
      }
    }

    const argCount = arguments.length - argOffset;

    if (argCount === 1) {
      const vertex = normalizePoint2D(arguments[argOffset])
      line = new LineTo(vertex, planeObj);
      context.addSceneObject(line)
    }
    else if (argCount === 2) {
      const start = normalizePoint2D(arguments[argOffset]);
      const end = normalizePoint2D(arguments[argOffset + 1]);
      line = new LineTo(end, planeObj);
      context.addSceneObjects([new Move(start), line]);
    }
    else {
      throw new Error(`Invalid number of arguments for line(): ${argCount}`);
    }

    return line;
  } as LineFunction
}

export default registerBuilder(build);
