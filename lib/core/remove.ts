import { SceneObject } from "../common/scene-object.js";
import { registerBuilder, SceneParserContext } from "../index.js";
import { Remove } from "../features/remove.js";

function build(context: SceneParserContext) {
  return function remove(...args: (SceneObject[])): Remove {
    const remove = new Remove(args);
    context.addSceneObject(remove);
    return remove;
  }
}

export default registerBuilder(build);
