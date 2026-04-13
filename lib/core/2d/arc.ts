import { isPoint2DLike, Point2DLike } from "../../math/point.js";
import { ArcFromTwoAngles } from "../../features/2d/arc.js";
import { ArcToPoint } from "../../features/2d/arc-to-point.js";
import { ArcThreePoints } from "../../features/2d/arc-three-points.js";
import { Move } from "../../features/2d/move.js";
import { normalizePoint2D } from "../../helpers/normalize.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { PlaneObjectBase } from "../../features/plane-renderable-base.js";
import { isPlaneLike, PlaneLike } from "../../math/plane.js";
import { SceneObject } from "../../common/scene-object.js";
import { resolvePlane } from "../../helpers/resolve.js";
import { IGeometry, ISceneObject } from "../interfaces.js";

interface ArcFunction {
  /**
   * Draws an arc to an end point with an optional bulge radius.
   * @param endPoint - The end point of the arc
   * @param radius - The bulge radius (0 = auto)
   */
  (endPoint: Point2DLike, radius?: number): IGeometry;
  /**
   * Draws an arc from a start point to an end point with an optional bulge radius.
   * @param startPoint - The start point of the arc
   * @param endPoint - The end point of the arc
   * @param radius - The bulge radius (0 = auto)
   */
  (startPoint: Point2DLike, endPoint: Point2DLike, radius?: number): IGeometry;
  /**
   * Draws an arc by radius and angle range.
   * @param radius - The arc radius
   * @param startAngle - The start angle in degrees (defaults to 0)
   * @param endAngle - The end angle in degrees (defaults to 180)
   * @param centered - Whether to center the arc on the current position
   */
  (radius: number, startAngle?: number, endAngle?: number, centered?: boolean): IGeometry;

  /**
   * Draws an arc from a start point to an end point around a center point.
   * @param startPoint - The start point of the arc
   * @param endPoint - The end point of the arc
   * @param center - The center point of the arc
   */
  (startPoint: Point2DLike, endPoint: Point2DLike, center: Point2DLike): IGeometry;

  /**
   * Draws an arc to an end point on a specific plane.
   * @param endPoint - The end point of the arc
   * @param targetPlane - The plane to draw on
   */
  (endPoint: Point2DLike, targetPlane: PlaneLike | ISceneObject): IGeometry;
  /**
   * Draws an arc to an end point with a bulge radius on a specific plane.
   * @param endPoint - The end point of the arc
   * @param radius - The bulge radius
   * @param targetPlane - The plane to draw on
   */
  (endPoint: Point2DLike, radius: number, targetPlane: PlaneLike | ISceneObject): IGeometry;
  /**
   * Draws an arc between two points on a specific plane.
   * @param startPoint - The start point of the arc
   * @param endPoint - The end point of the arc
   * @param targetPlane - The plane to draw on
   */
  (startPoint: Point2DLike, endPoint: Point2DLike, targetPlane: PlaneLike | ISceneObject): IGeometry;
  /**
   * Draws an arc between two points with a bulge radius on a specific plane.
   * @param startPoint - The start point of the arc
   * @param endPoint - The end point of the arc
   * @param radius - The bulge radius
   * @param targetPlane - The plane to draw on
   */
  (startPoint: Point2DLike, endPoint: Point2DLike, radius: number, targetPlane: PlaneLike | ISceneObject): IGeometry;
  /**
   * Draws an arc from a start point to an end point around a center point on a specific plane.
   * @param startPoint - The start point of the arc
   * @param endPoint - The end point of the arc
   * @param center - The center point of the arc
   * @param targetPlane - The plane to draw on
   */
  (startPoint: Point2DLike, endPoint: Point2DLike, center: Point2DLike, targetPlane: PlaneLike | ISceneObject): IGeometry;
  /**
   * Draws an arc by radius on a specific plane.
   * @param radius - The arc radius
   * @param targetPlane - The plane to draw on
   */
  (radius: number, targetPlane: PlaneLike | ISceneObject): IGeometry;
  /**
   * Draws an arc by radius and start angle on a specific plane.
   * @param radius - The arc radius
   * @param startAngle - The start angle in degrees
   * @param targetPlane - The plane to draw on
   */
  (radius: number, startAngle: number, targetPlane: PlaneLike | ISceneObject): IGeometry;
  /**
   * Draws an arc by radius and angle range on a specific plane.
   * @param radius - The arc radius
   * @param startAngle - The start angle in degrees
   * @param endAngle - The end angle in degrees
   * @param targetPlane - The plane to draw on
   */
  (radius: number, startAngle: number, endAngle: number, targetPlane: PlaneLike | ISceneObject): IGeometry;
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

    // (startPoint, endPoint, center) — three Point2DLike args
    if (argCount >= 3 && isPoint2DLike(arguments[0]) && isPoint2DLike(arguments[1]) && isPoint2DLike(arguments[2])) {
      const start = normalizePoint2D(arguments[0] as Point2DLike);
      const end = normalizePoint2D(arguments[1] as Point2DLike);
      const center = normalizePoint2D(arguments[2] as Point2DLike);
      const arcObj = new ArcThreePoints(start, end, center, planeObj);
      context.addSceneObjects([new Move(start), arcObj]);
      return arcObj;
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
