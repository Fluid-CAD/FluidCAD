import { Point2DLike, isPoint2DLike } from "../../math/point.js";
import { LineTo } from "../../features/2d/line.js";
import { Move } from "../../features/2d/move.js";
import { normalizePoint2D } from "../../helpers/normalize.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { PlaneObjectBase } from "../../features/plane-renderable-base.js";
import { isPlaneLike, PlaneLike } from "../../math/plane.js";
import { SceneObject } from "../../common/scene-object.js";
import { resolvePlane } from "../../helpers/resolve.js";

interface LineFunction {
  (end: Point2DLike): LineTo;
  (start: Point2DLike, end: Point2DLike): LineTo;
  (end: Point2DLike, targetPlane: PlaneLike | SceneObject): LineTo;
}

function build(context: SceneParserContext): LineFunction {
  return function line() {
    let line: LineTo;
    let planeObj: PlaneObjectBase | null = null;
    let argCount = arguments.length;

    // Detect plane as last argument
    // Point2DLike is not plane-like so no conflict
    if (argCount > 0) {
      const lastArg = arguments[argCount - 1];
      if (isPlaneLike(lastArg) || (lastArg instanceof SceneObject && !isPoint2DLike(lastArg))) {
        planeObj = resolvePlane(lastArg, context);
        argCount--;
      }
    }

    if (argCount === 1) {
      const vertex = normalizePoint2D(arguments[0])
      line = new LineTo(vertex, planeObj);
      context.addSceneObject(line)
    }
    else if (argCount === 2) {
      const start = normalizePoint2D(arguments[0]);
      const vertex = normalizePoint2D(arguments[1]);
      line = new LineTo(vertex, planeObj);
      context.addSceneObjects([new Move(start), line]);
    }
    else {
      throw new Error(`Invalid number of arguments for line(): ${argCount}`);
    }

    return line;
  } as LineFunction
}

export default registerBuilder(build);
