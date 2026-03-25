import { SceneObject } from "../common/scene-object.js";
import { registerBuilder, SceneParserContext } from "../index.js";
import { Remove } from "../features/remove.js";
import { ISceneObject } from "./interfaces.js";

interface RemoveFunction {
  /**
   * Removes the given objects from the scene.
   * @param objects - The objects to remove
   */
  (...objects: ISceneObject[]): ISceneObject;
}

function build(context: SceneParserContext): RemoveFunction {
  return function remove(...args: (ISceneObject[])): ISceneObject {
    const remove = new Remove(args as SceneObject[]);
    context.addSceneObject(remove);
    return remove;
  } as RemoveFunction;
}

export default registerBuilder(build);
