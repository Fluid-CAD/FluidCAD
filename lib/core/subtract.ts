
import { registerBuilder, SceneParserContext } from "../index.js";
import { Subtract } from "../features/subtract.js";
import { SceneObject } from "../common/scene-object.js";
import { ISceneObject } from "./interfaces.js";

function build(context: SceneParserContext) {
  return function subtract(solid1: ISceneObject, solid2: ISceneObject): ISceneObject {
    const subtract = new Subtract(solid1 as SceneObject, solid2 as SceneObject);
    context.addSceneObject(subtract);
    return subtract;
  }
}

export default registerBuilder(build);
