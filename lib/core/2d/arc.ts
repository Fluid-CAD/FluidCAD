import { isPoint2DLike, Point2DLike } from "../../math/point.js";
import { ArcFromTwoAngles } from "../../features/2d/arc.js";
import { ArcToPoint } from "../../features/2d/arc-to-point.js";
import { Move } from "../../features/2d/move.js";
import { normalizePoint2D } from "../../helpers/normalize.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { PlaneObjectBase } from "../../features/plane-renderable-base.js";
import { isPlaneLike, PlaneLike } from "../../math/plane.js";
import { SceneObject } from "../../common/scene-object.js";
import { resolvePlane } from "../../helpers/resolve.js";

interface ArcFunction {
  // Sketch-based (no plane)
  (endPoint: Point2DLike, radius?: number): ArcToPoint;
  (startPoint: Point2DLike, endPoint: Point2DLike, radius?: number): ArcToPoint;
  (radius: number, startAngle?: number, endAngle?: number, centered?: boolean): ArcFromTwoAngles;

  //  Non-sketch
  (endPoint: Point2DLike, targetPlane: PlaneLike | SceneObject): ArcToPoint;
  (endPoint: Point2DLike, radius: number, targetPlane: PlaneLike | SceneObject): ArcToPoint;
  (startPoint: Point2DLike, endPoint: Point2DLike, targetPlane: PlaneLike | SceneObject): ArcToPoint;
  (startPoint: Point2DLike, endPoint: Point2DLike, radius: number, targetPlane: PlaneLike | SceneObject): ArcToPoint;
  (radius: number, targetPlane: PlaneLike | SceneObject): ArcFromTwoAngles;
  (radius: number, startAngle: number, targetPlane: PlaneLike | SceneObject): ArcFromTwoAngles;
  (radius: number, startAngle: number, endAngle: number, targetPlane: PlaneLike | SceneObject): ArcFromTwoAngles;
}

function build(context: SceneParserContext): ArcFunction {
  return function arc() {
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

    // (startPoint, endPoint, radius?) — two Point2DLike args
    if (argCount >= 2 && isPoint2DLike(arguments[0]) && isPoint2DLike(arguments[1])) {
      const start = normalizePoint2D(arguments[0] as Point2DLike);
      const end = normalizePoint2D(arguments[1] as Point2DLike);
      const radius = argCount >= 3 ? arguments[2] as number : 0;
      const arcObj = new ArcToPoint(end, radius, planeObj);
      context.addSceneObjects([new Move(start), arcObj]);
      return arcObj;
    }

    // (endPoint, radius?) — single Point2DLike arg
    if (isPoint2DLike(arguments[0])) {
      const end = normalizePoint2D(arguments[0] as Point2DLike);
      const radius = argCount >= 2 ? arguments[1] as number : 0;
      const arcObj = new ArcToPoint(end, radius, planeObj);
      context.addSceneObject(arcObj);
      return arcObj;
    }

    // (radius, startAngle, endAngle?, centered?) — all numeric args
    const radius = arguments[0] as number || 100;
    const startAngle = arguments[1] as number || 0;
    const endAngle = argCount >= 3 ? arguments[2] as number : 180;
    const centered = argCount >= 4 ? arguments[3] as boolean : false;

    const arcObj = new ArcFromTwoAngles(radius, startAngle, endAngle, centered, planeObj);
    context.addSceneObject(arcObj);
    return arcObj;
  } as ArcFunction;
}

export default registerBuilder(build);
