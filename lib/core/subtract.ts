
import { registerBuilder, SceneParserContext } from "../index.js";
import { Subtract } from "../features/subtract.js";
import { SceneObject } from "../common/scene-object.js";
import { ISceneObject } from "./interfaces.js";

interface SubtractFunction {
  /**
   * Subtracts the second solid from the first (boolean difference).
   * @param solid1 - The base solid
   * @param solid2 - The solid to subtract
   */
  (solid1: ISceneObject, solid2: ISceneObject): ISceneObject;
}

function build(context: SceneParserContext): SubtractFunction {
  return function subtract(solid1: ISceneObject, solid2: ISceneObject): ISceneObject {
    const subtract = new Subtract(solid1 as SceneObject, solid2 as SceneObject);
    context.addSceneObject(subtract);
    return subtract;
  }
}

export default registerBuilder(build);
