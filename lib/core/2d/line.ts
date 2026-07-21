import { Point2DLike } from "../../math/point.js";
import { LineTo } from "../../features/2d/line.js";
import { Move } from "../../features/2d/move.js";
import { normalizePoint2D } from "../../helpers/normalize.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { IGeometry } from "../interfaces.js";

interface LineFunction {
  /**
   * Draws a line from the current position to the given point.
   * @param end - The end point
   */
  (end: Point2DLike): IGeometry;
  /**
   * Draws a line between two points.
   * @param start - The start point
   * @param end - The end point
   */
  (start: Point2DLike, end: Point2DLike): IGeometry;
}

function build(context: SceneParserContext): LineFunction {
  return function line() {
    let line: LineTo;
    const argCount = arguments.length;

    if (argCount === 1) {
      const vertex = normalizePoint2D(arguments[0])
      line = new LineTo(vertex, null);
      context.addSceneObject(line)
    }
    else if (argCount === 2) {
      const start = normalizePoint2D(arguments[0]);
      const end = normalizePoint2D(arguments[1]);
      line = new LineTo(end, null);
      line.setHasExplicitStart();
      context.addSceneObjects([new Move(start), line]);
    }
    else {
      throw new Error(`Invalid number of arguments for line(): ${argCount}`);
    }

    return line;
  } as LineFunction
}

export default registerBuilder(build);
