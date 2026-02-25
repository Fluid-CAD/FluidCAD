import { Point2D, Point2DLike } from "../../math/point.js";
import { RMove } from "../../features/2d/rmove.js";
import { normalizePoint2D } from "../../helpers/normalize.js";
import { registerBuilder, SceneParserContext } from "../../index.js";

interface RMoveFunction {
  (angle: number): RMove;
  (angle: number, pivot: Point2DLike): RMove;
}

function build(context: SceneParserContext): RMoveFunction {
  return function rmove() {
    const angle = (arguments[0] as number) * Math.PI / 180;
    const pivot = normalizePoint2D(arguments[1] || new Point2D(0, 0))
    const rmove = new RMove(pivot, angle)
    context.addSceneObject(rmove);

    return rmove;
  }
}

export default registerBuilder(build);
