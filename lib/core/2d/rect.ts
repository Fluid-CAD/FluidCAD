import { Point2DLike, isPoint2DLike } from "../../math/point.js";
import { Move } from "../../features/2d/move.js";
import { Rect, RectOptions } from "../../features/2d/rect.js";
import { normalizePoint2D } from "../../helpers/normalize.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { LazyVertex } from "../../features/lazy-vertex.js";
import { PlaneObjectBase } from "../../features/plane-renderable-base.js";
import { isPlaneLike, PlaneLike } from "../../math/plane.js";
import { SceneObject } from "../../common/scene-object.js";
import { resolvePlane } from "../../helpers/resolve.js";

interface RectFunction {
  (width: number, height?: number, options?: RectOptions): Rect;
  (start: Point2DLike, width: number, height?: number, options?: RectOptions): Rect;
  (width: number, height: number, targetPlane: PlaneLike | SceneObject): Rect;
  (width: number, height: number, options: RectOptions, targetPlane: PlaneLike | SceneObject): Rect;
}

function build(context: SceneParserContext): RectFunction {
  return function cRect() {
    let width: number;
    let height: number;
    let options: RectOptions;
    let start: LazyVertex;
    let rect: Rect;
    let planeObj: PlaneObjectBase | null = null;
    let argCount = arguments.length;

    // Detect plane as last argument
    if (argCount > 0) {
      const lastArg = arguments[argCount - 1];
      if (isPlaneLike(lastArg) || (lastArg instanceof SceneObject && !isPoint2DLike(lastArg))) {
        planeObj = resolvePlane(lastArg, context);
        argCount--;
      }
    }

    if (argCount === 1) {
      width = arguments[0] as number;
      height = width;

      rect = new Rect(width, height, false, options, planeObj);
      context.addSceneObject(rect);
    }
    else if (argCount === 2) {
      if (typeof arguments[0] === 'number') {
        width = arguments[0] as number;
        height = arguments[1] as number;

        rect = new Rect(width, height, false, options, planeObj);
        context.addSceneObject(rect);
      } else {
        start = normalizePoint2D(arguments[0]);
        width = arguments[1] as number;
        height = width;

        rect = new Rect(width, height, false, options, planeObj);
        context.addSceneObjects([new Move(start), rect]);
      }
    }
    else if (argCount === 3) {
      if (typeof arguments[0] === 'number') {
        width = arguments[0] as number;
        height = arguments[1] as number;
        options = arguments[2] as RectOptions;

        rect = new Rect(width, height, false, options, planeObj);
        context.addSceneObject(rect);
      } else {
        start = normalizePoint2D(arguments[0]);
        width = arguments[1] as number;
        height = arguments[2] as number;

        rect = new Rect(width, height, false, options, planeObj);
        context.addSceneObjects([new Move(start), rect]);
      }
    }
    else if (argCount === 4) {
      start = normalizePoint2D(arguments[0]);
      width = arguments[1] as number;
      height = arguments[2] as number;
      options = arguments[3] as RectOptions;

      rect = new Rect(width, height, false, options, planeObj);
      context.addSceneObjects([new Move(start), rect]);
    }

    return rect;
  } as RectFunction
}

export default registerBuilder(build);
