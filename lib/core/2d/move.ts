import { Point2D, Point2DLike } from "../../math/point.js";
import { Move } from "../../features/2d/move.js";
import { normalizePoint2D } from "../../helpers/normalize.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { IGeometry } from "../interfaces.js";
import { isNumberParam, NumberParam, resolveParam } from "../param.js";

interface MoveFunction {
  /** Moves the cursor to the origin. */
  (): IGeometry;
  /**
   * Moves the cursor to the given point.
   * @param to - The target point
   */
  (to: Point2DLike): IGeometry;
  /**
   * Moves the cursor by an offset from its current position. Like `hMove` and
   * `vMove`, the scalar form is relative — pass a point, `move([x, y])`, to
   * move to an absolute position instead.
   * @param dx - Horizontal offset
   * @param dy - Vertical offset
   */
  (dx: NumberParam, dy: NumberParam): IGeometry;
}

function build(context: SceneParserContext): MoveFunction {
  return function move() {
    // Two scalars are an offset from the current position; a single point
    // argument is an absolute destination.
    if (arguments.length === 2 && isNumberParam(arguments[0]) && isNumberParam(arguments[1])) {
      const relative = Move.relative(
        resolveParam(arguments[0] as NumberParam),
        resolveParam(arguments[1] as NumberParam),
      );
      context.addSceneObject(relative);

      return relative;
    }

    const to = normalizePoint2D(arguments[0] ?? new Point2D(0, 0));
    const move = new Move(to)
    context.addSceneObject(move);

    return move;
  }
}

export default registerBuilder(build);
