import { Point2D, Point2DLike } from "../../math/point.js";
import { Move } from "../../features/2d/move.js";
import { normalizePoint2D } from "../../helpers/normalize.js";
import { registerBuilder, SceneParserContext } from "../../index.js";

interface MoveFunction {
  (): Move;
  (to: Point2DLike): Move;
}

function build(context: SceneParserContext): MoveFunction {
  return function move() {
    const to = normalizePoint2D(arguments[0] ?? new Point2D(0, 0));
    const move = new Move(to)
    context.addSceneObject(move);

    return move;
  }
}

export default registerBuilder(build);
