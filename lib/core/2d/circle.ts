import { Point2DLike, isPoint2DLike } from "../../math/point.js";
import { Circle } from "../../features/2d/circle.js";
import { Move } from "../../features/2d/move.js";
import { normalizePoint2D } from "../../helpers/normalize.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { LazyVertex } from "../../features/lazy-vertex.js";
import { PlaneObjectBase } from "../../features/plane-renderable-base.js";
import { isPlaneLike, PlaneLike } from "../../math/plane.js";
import { SceneObject } from "../../common/scene-object.js";
import { resolvePlane } from "../../helpers/resolve.js";
import { IExtrudableGeometry, ISceneObject } from "../interfaces.js";

interface CircleFunction {
  (center: Point2DLike, radius?: number): IExtrudableGeometry;
  (radius?: number): IExtrudableGeometry;
  (radius: number, targetPlane: PlaneLike | ISceneObject): IExtrudableGeometry;
}

function build(context: SceneParserContext): CircleFunction {
  return function circle() {
    let radius: number;
    let center: LazyVertex;
    let circle: Circle;
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

    if (argCount === 0) {
      radius = 20;
      circle = new Circle(radius, null, planeObj);
      context.addSceneObject(circle);
    }
    else if (argCount === 1) {
      radius = arguments[0] as number || 20;
      circle = new Circle(radius, null, planeObj);
      context.addSceneObject(circle);
    }
    else {
      center = normalizePoint2D(arguments[0]);
      radius = arguments[1] as number || 20;
      circle = new Circle(radius, null, planeObj);
      const move = new Move(center);
      context.addSceneObjects([move, circle]);
    }

    return circle;
  } as CircleFunction;
}

export default registerBuilder(build);
