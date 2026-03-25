import { Point2DLike, isPoint2DLike } from "../../math/point.js";
import { Move } from "../../features/2d/move.js";
import { VerticalLine } from "../../features/2d/vline.js";
import { normalizePoint2D } from "../../helpers/normalize.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { PlaneObjectBase } from "../../features/plane-renderable-base.js";
import { isPlaneLike, PlaneLike } from "../../math/plane.js";
import { SceneObject } from "../../common/scene-object.js";
import { resolvePlane } from "../../helpers/resolve.js";
import { IGeometry, ISceneObject } from "../interfaces.js";

interface VLineFunction {
  (distance: number, centered?: boolean): IGeometry;
  (start: Point2DLike, distance: number, centered?: boolean): IGeometry;
  (distance: number, targetPlane: PlaneLike | ISceneObject): IGeometry;
  (distance: number, centered: boolean, targetPlane: PlaneLike | ISceneObject): IGeometry;
}

function build(context: SceneParserContext): VLineFunction {
  return function line() {
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

    if (typeof arguments[0] !== 'number') {
      // vline(start, distance) or vline(start, distance, centered)
      const start = normalizePoint2D(arguments[0]);
      const distance: number = arguments[1];
      const centered = argCount >= 3 ? (arguments[2] as boolean) : false;
      const vline = new VerticalLine(distance, centered, planeObj);
      context.addSceneObjects([new Move(start), vline]);
      return vline;
    }

    const distance: number = arguments[0];
    const centered = argCount >= 2 ? (arguments[1] as boolean) : false;

    const vline = new VerticalLine(distance, centered, planeObj);
    context.addSceneObject(vline);

    return vline;
  } as VLineFunction
}

export default registerBuilder(build);
