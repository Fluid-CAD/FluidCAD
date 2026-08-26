import { Point2DLike } from "../../math/point.js";
import { SolvedLine } from "../../features/2d/solved/line.js";
import { normalizePoint2D } from "../../helpers/normalize.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { ISolvedLine } from "../interfaces.js";

interface LineFunction {
  /**
   * Draws a line between two points. The statement is a solver entity whose
   * literals are guesses — `.start()`, `.end()` and `.mid()` reference its
   * points in constraints.
   * @param start - The start point
   * @param end - The end point
   */
  (start: Point2DLike, end: Point2DLike): ISolvedLine;
}

function build(context: SceneParserContext): LineFunction {
  return function line() {
    if (arguments.length !== 2) {
      throw new Error(
        "line() takes a start and an end — the chained line(end) pen form was removed; " +
        "write line(start, end) and pin the junction with coincident(prev.end(), l.start())",
      );
    }
    const solved = new SolvedLine(
      normalizePoint2D(arguments[0]).asPoint2D(),
      normalizePoint2D(arguments[1]).asPoint2D(),
    );
    context.addSceneObject(solved);
    const activeSketch = context.getActiveSketch();
    if (activeSketch) {
      solved.register(activeSketch);
    }
    return solved;
  } as LineFunction;
}

export default registerBuilder(build);
