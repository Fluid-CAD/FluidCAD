import { HMove } from "../../features/2d/hmove.js";
import { registerBuilder, SceneParserContext } from "../../index.js";

interface HMoveFunction {
  (distance: number): void;
}

function build(context: SceneParserContext): HMoveFunction {
  return function move() {
    const distance = arguments[0] as number;
    const hmove = new HMove(distance)
    context.addSceneObject(hmove);

    return hmove;
  }
}

export default registerBuilder(build);

