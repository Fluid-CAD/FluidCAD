import { Point2DLike } from "../../math/point.js";
import { SplineCurve } from "../../features/2d/spline.js";
import { LazyVertex } from "../../features/lazy-vertex.js";
import { normalizePoint2D } from "../../helpers/normalize.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { ISpline } from "../interfaces.js";

interface SplineFunction {
  /**
   * Draws a smooth curve through the given points, in order — the first is
   * the start, the last the end, and the curve passes through every point
   * between (a cubic interpolating B-spline, C2 continuous; a bezier's
   * points pull the curve, a spline's lie on it). Inside a sketch every
   * literal point is a solver point entity — constraints target `.point(i)`
   * (or `.start()`/`.end()`) and the solve reshapes the curve; a point
   * given as another entity's accessor (e.g. `l.end()`) rides that entity
   * instead.
   * With 0 args: interactive mode placeholder (no geometry).
   * With 1 arg: places only the start point (no curve yet).
   * With 2 args: a straight segment from start to end.
   * With 3 or more args: the curve through every point.
   * @param points - The points the curve passes through, start to end
   */
  (...points: Point2DLike[]): ISpline;
}

function build(context: SceneParserContext): SplineFunction {
  return function spline() {
    const fitPoints = [];
    const literalIndices: number[] = [];
    for (let i = 0; i < arguments.length; i++) {
      // An arg that is already a LazyVertex references another entity's
      // point — it stays that entity's solver param. Literals register as
      // this statement's own solver points.
      if (!(arguments[i] instanceof LazyVertex)) {
        literalIndices.push(i);
      }
      fitPoints.push(normalizePoint2D(arguments[i]));
    }
    const curve = new SplineCurve(fitPoints, literalIndices);
    context.addSceneObject(curve);
    const activeSketch = context.getActiveSketch();
    if (activeSketch) {
      curve.register(activeSketch);
    }
    return curve;
  } as SplineFunction;
}

export default registerBuilder(build);
