import { isPoint2DLike, Point2DLike } from "../../math/point.js";
import { Arc } from "../../features/2d/arc.js";
import { normalizePoint2D } from "../../helpers/normalize.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { PlaneObjectBase } from "../../features/plane-renderable-base.js";
import { isPlaneLike, PlaneLike } from "../../math/plane.js";
import { SceneObject } from "../../common/scene-object.js";
import { resolvePlane } from "../../helpers/resolve.js";
import { IArcPoints, IArcAngles, ISceneObject } from "../interfaces.js";

interface ArcFunction {
  /**
   * Draws an arc to an end point from the current position.
   * Chain `.radius(r)` to set bulge radius, or `.center(point)` to specify the circle center.
   * @param endPoint - The end point of the arc
   */
  (endPoint: Point2DLike): IArcPoints;
  /**
   * Draws an arc from a start point to an end point.
   * By default, uses the current position as the arc center.
   * Chain `.radius(r)` to use bulge radius instead, or `.center(point)` to specify an explicit center.
   * @param startPoint - The start point of the arc
   * @param endPoint - The end point of the arc
   */
  (startPoint: Point2DLike, endPoint: Point2DLike): IArcPoints;
  /**
   * Draws an arc by radius and angle range at the current position.
   * Chain `.centered()` to center the arc symmetrically around the start angle.
   * @param radius - The arc radius
   * @param startAngle - The start angle in degrees (defaults to 0)
   * @param endAngle - The end angle in degrees (defaults to 180)
   */
  (radius: number, startAngle?: number, endAngle?: number): IArcAngles;

  /**
   * Draws an arc to an end point on a specific plane.
   * @param endPoint - The end point of the arc
   * @param targetPlane - The plane to draw on
   */
  (endPoint: Point2DLike, targetPlane: PlaneLike | ISceneObject): IArcPoints;
  /**
   * Draws an arc between two points on a specific plane.
   * @param startPoint - The start point of the arc
   * @param endPoint - The end point of the arc
   * @param targetPlane - The plane to draw on
   */
  (startPoint: Point2DLike, endPoint: Point2DLike, targetPlane: PlaneLike | ISceneObject): IArcPoints;
  /**
   * Draws an arc by radius and angle range on a specific plane.
   * @param radius - The arc radius
   * @param startAngle - The start angle in degrees
   * @param endAngle - The end angle in degrees
   * @param targetPlane - The plane to draw on
   */
  (radius: number, startAngle: number, endAngle: number, targetPlane: PlaneLike | ISceneObject): IArcAngles;
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

    // (startPoint, endPoint) — two Point2DLike args, default center = current position
    if (argCount >= 2 && isPoint2DLike(arguments[0]) && isPoint2DLike(arguments[1])) {
      const start = normalizePoint2D(arguments[0] as Point2DLike);
      const end = normalizePoint2D(arguments[1] as Point2DLike);
      const arcObj = Arc.twoPoints(start, end, planeObj);
      context.addSceneObject(arcObj);
      return arcObj;
    }

    // (endPoint) — single Point2DLike arg
    if (isPoint2DLike(arguments[0])) {
      const end = normalizePoint2D(arguments[0] as Point2DLike);
      const arcObj = Arc.toPoint(end, planeObj);
      context.addSceneObject(arcObj);
      return arcObj;
    }

    // (radius, startAngle?, endAngle?) — all numeric args
    const radius = arguments[0] as number || 100;
    const startAngle = arguments[1] as number || 0;
    const endAngle = argCount >= 3 ? arguments[2] as number : 180;

    const arcObj = Arc.fromAngles(radius, startAngle, endAngle, planeObj);
    context.addSceneObject(arcObj);
    return arcObj;
  } as ArcFunction;
}

export default registerBuilder(build);
