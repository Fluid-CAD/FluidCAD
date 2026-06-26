import { isPoint2DLike, Point2DLike } from "../../math/point.js";
import { Arc } from "../../features/2d/arc.js";
import { normalizePoint2D } from "../../helpers/normalize.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { IArcPoints, IArcAngles } from "../interfaces.js";
import { type NumberParam, resolveParam } from "../param.js";

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
   * Angles are measured relative to the current tangent (the tangent of the previous
   * geometry, or +X when there is none).
   * Chain `.centered()` to center the arc symmetrically around the start angle.
   * @param radius - The arc radius
   * @param startAngle - The start angle in degrees, relative to the current tangent (defaults to 0)
   * @param endAngle - The end angle in degrees, relative to the current tangent (defaults to 180)
   */
  (radius: NumberParam, startAngle?: NumberParam, endAngle?: NumberParam): IArcAngles;
}

function build(context: SceneParserContext): ArcFunction {
  return function arc() {
    // (startPoint, endPoint) — two Point2DLike args, default center = current position
    if (arguments.length >= 2 && isPoint2DLike(arguments[0]) && isPoint2DLike(arguments[1])) {
      const start = normalizePoint2D(arguments[0] as Point2DLike);
      const end = normalizePoint2D(arguments[1] as Point2DLike);
      const arcObj = Arc.twoPoints(start, end);
      context.addSceneObject(arcObj);
      return arcObj;
    }

    // (endPoint) — single Point2DLike arg
    if (isPoint2DLike(arguments[0])) {
      const end = normalizePoint2D(arguments[0] as Point2DLike);
      const arcObj = Arc.toPoint(end);
      context.addSceneObject(arcObj);
      return arcObj;
    }

    // (radius, startAngle?, endAngle?) — all numeric args
    const radius = resolveParam(arguments[0] as NumberParam) || 100;
    const startAngle = resolveParam(arguments[1] as NumberParam) || 0;
    const endAngle = arguments.length >= 3 ? resolveParam(arguments[2] as NumberParam) : 180;

    const arcObj = Arc.fromAngles(radius, startAngle, endAngle);
    context.addSceneObject(arcObj);
    return arcObj;
  } as ArcFunction;
}

export default registerBuilder(build);
