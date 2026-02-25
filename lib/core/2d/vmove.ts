import { VMove } from "../../features/2d/vmove.js";
import { registerBuilder, SceneParserContext } from "../../index.js";

interface VMoveFunction {
  (distance: number): void;
}

function build(context: SceneParserContext): VMoveFunction {
  return function move() {
    const distance = arguments[0] as number;
    const move = new VMove(distance)
    context.addSceneObject(move);

    return move;
  }
}

export default registerBuilder(build);

