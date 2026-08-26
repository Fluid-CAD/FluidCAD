import { isPoint2DLike, Point2DLike } from "../../math/point.js";
import { SolvedArc } from "../../features/2d/solved/arc.js";
import { normalizePoint2D } from "../../helpers/normalize.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { ISolvedArc } from "../interfaces.js";

interface ArcFunction {
  /**
   * Draws an arc fully specified by start, end and center guesses. Chain
   * `.cw()` to flip the sweep side.
   * @param startPoint - The start point
   * @param endPoint - The end point
   * @param centerPoint - The center point
   */
  (startPoint: Point2DLike, endPoint: Point2DLike, centerPoint: Point2DLike): ISolvedArc;
}

function build(context: SceneParserContext): ArcFunction {
  return function arc() {
    if (arguments.length < 3
        || !isPoint2DLike(arguments[0]) || !isPoint2DLike(arguments[1]) || !isPoint2DLike(arguments[2])) {
      throw new Error(
        "arc() needs full specification — arc(start, end, center); " +
        "the chained/radius/angle pen forms were removed (add tangent()/radius() constraints instead)",
      );
    }
    const solved = new SolvedArc(
      normalizePoint2D(arguments[0] as Point2DLike).asPoint2D(),
      normalizePoint2D(arguments[1] as Point2DLike).asPoint2D(),
      normalizePoint2D(arguments[2] as Point2DLike).asPoint2D(),
    );
    context.addSceneObject(solved);
    const activeSketch = context.getActiveSketch();
    if (activeSketch) {
      solved.register(activeSketch);
    }
    return solved;
  } as ArcFunction;
}

export default registerBuilder(build);
