
import { registerBuilder, SceneParserContext } from "../index.js";
import { Subtract } from "../features/subtract.js";
import { SceneObject } from "../common/scene-object.js";

function build(context: SceneParserContext) {
  return function subtract(solid1: SceneObject, solid2: SceneObject) {
    const subtract = new Subtract(solid1, solid2);
    context.addSceneObject(subtract);
    return subtract;
  }
}

export default registerBuilder(build);
