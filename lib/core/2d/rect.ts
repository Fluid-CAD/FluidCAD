import { Point2DLike, isPoint2DLike } from "../../math/point.js";
import { Move } from "../../features/2d/move.js";
import { Rect } from "../../features/2d/rect.js";
import { normalizePoint2D } from "../../helpers/normalize.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { LazyVertex } from "../../features/lazy-vertex.js";
import { PlaneObjectBase } from "../../features/plane-renderable-base.js";
import { isPlaneLike, PlaneLike } from "../../math/plane.js";
import { SceneObject } from "../../common/scene-object.js";
import { resolvePlane } from "../../helpers/resolve.js";
import { IRect, ISceneObject } from "../interfaces.js";

interface RectFunction {
  (width: number, height?: number): IRect;
  (start: Point2DLike, width: number, height?: number): IRect;
  (width: number, height: number, targetPlane: PlaneLike | ISceneObject): IRect;
}

function build(context: SceneParserContext): RectFunction {
  return function cRect() {
    let argCount = arguments.length;

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
      if (typeof arguments[0] === 'number') {
        const width = arguments[0] as number;
        const height = arguments[1] as number;

        const lastArg = arguments[argCount - 1];
        let planeObj: PlaneObjectBase;
        if (isPlaneLike(lastArg) || (lastArg instanceof SceneObject && !isPoint2DLike(lastArg))) {
          planeObj = resolvePlane(lastArg, context);
        }

        const rect = new Rect(width, height, planeObj);
        context.addSceneObject(rect);
        return rect;
      } else {
        const start = normalizePoint2D(arguments[0]);
        const width = arguments[1] as number;
        const height = arguments[2] as number;

        const rect = new Rect(width, height);
        context.addSceneObjects([new Move(start), rect]);
        return rect;
      }
    }
  } as RectFunction
}

export default registerBuilder(build);
