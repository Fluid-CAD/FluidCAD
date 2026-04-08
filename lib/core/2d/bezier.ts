import { Point2DLike } from "../../math/point.js";
import { BezierCurve } from "../../features/2d/bezier.js";
import { normalizePoint2D } from "../../helpers/normalize.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { IGeometry } from "../interfaces.js";

interface BezierFunction {
  /**
   * Draws a bezier curve from the current position through control points to the end point.
   * The last argument is the endpoint; all preceding arguments are control points.
   * With 0 args: interactive mode placeholder (no geometry).
   * With 1 arg: degree 1 (line).
   * With 2 args: degree 2 (quadratic bezier).
   * With 3 args: degree 3 (cubic bezier).
   * @param points - Control points and end point
   */
  (...points: Point2DLike[]): IGeometry;
}

function build(context: SceneParserContext): BezierFunction {
  return function bezier() {
    const controlPoints = [];
    for (let i = 0; i < arguments.length; i++) {
      controlPoints.push(normalizePoint2D(arguments[i]));
    }
    const curve = new BezierCurve(controlPoints);
    context.addSceneObject(curve);
    return curve;
  } as BezierFunction;
}

export default registerBuilder(build);
