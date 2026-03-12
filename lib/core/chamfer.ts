import { Chamfer } from "../features/chamfer.js";
import { registerBuilder, SceneParserContext } from "../index.js";

function build(context: SceneParserContext) {
  return function chamfer(distance: number = 1, distance2?: number, isAngle?: boolean) {
    const selection = context.getLastSelection();

    const chamfer = new Chamfer(selection, distance, distance2, isAngle ?? false);
    context.addSceneObject(chamfer);

    return chamfer;
  };
}

export default registerBuilder(build);
