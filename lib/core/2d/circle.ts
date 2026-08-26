import { isPoint2DLike, Point2DLike } from "../../math/point.js";
import { SolvedCircle } from "../../features/2d/solved/circle.js";
import { normalizePoint2D } from "../../helpers/normalize.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { ISolvedCircle } from "../interfaces.js";
import { type NumberParam, resolveParam } from "../param.js";

interface CircleFunction {
  /**
   * Draws a circle at a given center with an optional diameter. The statement
   * is a solver entity — `.center()` references its center point in
   * constraints.
   * @param center - The center point
   * @param diameter - The circle diameter (defaults to 40)
   */
  (center: Point2DLike, diameter?: NumberParam): ISolvedCircle;
}

function build(context: SceneParserContext): CircleFunction {
  return function circle() {
    if (arguments.length < 1 || !isPoint2DLike(arguments[0])) {
      throw new Error(
        "circle() needs an explicit center — the center-less pen form was removed; " +
        "write circle([x, y], diameter)",
      );
    }
    const solved = new SolvedCircle(
      normalizePoint2D(arguments[0]).asPoint2D(),
      resolveParam(arguments[1] as NumberParam) || 40,
    );
    context.addSceneObject(solved);
    const activeSketch = context.getActiveSketch();
    if (activeSketch) {
      solved.register(activeSketch);
    }
    return solved;
  } as CircleFunction;
}

export default registerBuilder(build);
