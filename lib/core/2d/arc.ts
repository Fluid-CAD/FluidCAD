import { isPoint2DLike, Point2DLike } from "../../math/point.js";
import { ArcFromTwoAngles } from "../../features/2d/arc.js";
import { ArcFromCenterAndAngle } from "../../features/2d/arc-from-center.js";
import { Move } from "../../features/2d/move.js";
import { normalizePoint2D } from "../../helpers/normalize.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { LazyVertex } from "../../features/lazy-vertex.js";
import { PlaneObjectBase } from "../../features/plane-renderable-base.js";
import { isPlaneLike, PlaneLike } from "../../math/plane.js";
import { SceneObject } from "../../common/scene-object.js";
import { resolvePlane } from "../../helpers/resolve.js";

interface ArcFunction {
  (radius?: number, startAngle?: number, endAngle?: number): ArcFromTwoAngles;
  (startPoint: Point2DLike, radius?: number, startAngle?: number, endAngle?: number): ArcFromTwoAngles;
  (radius: number, startAngle: number, endAngle: number, targetPlane: PlaneLike | SceneObject): ArcFromTwoAngles;
  (center: Point2DLike, angle: number, centered?: boolean): ArcFromCenterAndAngle;
}

function build(context: SceneParserContext): ArcFunction {
  return function arc() {
    let radius: number;
    let startAngle: number;
    let endAngle: number;
    let center: LazyVertex;
    let arc: ArcFromTwoAngles;
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

    if (isPoint2DLike(arguments[0])) {
      center = normalizePoint2D(arguments[0] as Point2DLike);

      // arc(center, angle, centered?) - sweep around center by angle degrees
      if (argCount === 2 || (argCount === 3 && typeof arguments[2] === 'boolean')) {
        const angle = arguments[1] as number;
        const centered = argCount === 3 ? arguments[2] as boolean : false;
        const arcFromCenter = new ArcFromCenterAndAngle(center, angle, centered);
        context.addSceneObject(arcFromCenter);
        return arcFromCenter;
      }

      radius = arguments[1] as number || 100;
      startAngle = arguments[2] as number || 0;
      endAngle = arguments[3] as number || 90;

      arc = new ArcFromTwoAngles(radius, startAngle, endAngle, planeObj);
      context.addSceneObjects([arc]);
    } else {
      radius = arguments[0] as number || 100;
      startAngle = arguments[1] as number || 0;
      endAngle = arguments[2] as number || 90;

      arc = new ArcFromTwoAngles(radius, startAngle, endAngle, planeObj);
      context.addSceneObject(arc);
    }

    return arc;
  } as ArcFunction;
}

export default registerBuilder(build);
