import { Chamfer } from "../features/chamfer.js";
import { registerBuilder, SceneParserContext } from "../index.js";

function build(context: SceneParserContext) {
  return function chamfer(distance: number = 1, distance2?: number) {
    const selection = context.getLastSelection();

    const chamfer = new Chamfer(selection, distance, distance2);
    context.addSceneObject(chamfer);

    return chamfer;
  };
}

export default registerBuilder(build);
