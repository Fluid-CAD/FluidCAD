import { Point2DLike } from "../../math/point.js";
import { BezierCurve } from "../../features/2d/bezier.js";
import { LazyVertex } from "../../features/lazy-vertex.js";
import { normalizePoint2D } from "../../helpers/normalize.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { IBezier } from "../interfaces.js";

interface BezierFunction {
  /**
   * Draws a bezier curve through the given points. The first argument is the
   * explicit start, the last is the endpoint, and any in between are control
   * points. Inside a sketch every literal control point is a solver point
   * entity — constraints target `.point(i)` (or `.start()`/`.end()`) and the
   * solve reshapes the curve; a control point given as another entity's
   * accessor (e.g. `l.end()`) rides that entity instead.
   * With 0 args: interactive mode placeholder (no geometry).
   * With 1 arg: places only the start point (no curve yet).
   * With 2 args: degree 1 (straight line from start to end).
   * With 3 args: degree 2 (quadratic bezier with 1 control point).
   * With 4 args: degree 3 (cubic bezier with 2 control points).
   * @param points - Start, optional control points, and end point
   */
  (...points: Point2DLike[]): IBezier;
}

function build(context: SceneParserContext): BezierFunction {
  return function bezier() {
    const controlPoints = [];
    const literalIndices: number[] = [];
    for (let i = 0; i < arguments.length; i++) {
      // An arg that is already a LazyVertex references another entity's
      // point — it stays that entity's solver param. Literals register as
      // this statement's own solver points.
      if (!(arguments[i] instanceof LazyVertex)) {
        literalIndices.push(i);
      }
      controlPoints.push(normalizePoint2D(arguments[i]));
    }
    const curve = new BezierCurve(controlPoints, literalIndices);
    context.addSceneObject(curve);
    const activeSketch = context.getActiveSketch();
    if (activeSketch) {
      curve.register(activeSketch);
    }
    return curve;
  } as BezierFunction;
}

export default registerBuilder(build);
