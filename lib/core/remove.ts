import { SceneObject } from "../common/scene-object.js";
import { registerBuilder, SceneParserContext } from "../index.js";
import { Remove } from "../features/remove.js";
import { ISceneObject } from "./interfaces.js";

function build(context: SceneParserContext) {
  return function remove(...args: (ISceneObject[])): ISceneObject {
    const remove = new Remove(args as SceneObject[]);
    context.addSceneObject(remove);
    return remove;
  }
}

export default registerBuilder(build);
