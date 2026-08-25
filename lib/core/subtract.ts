
import { registerBuilder, SceneParserContext } from "../index.js";
import { Subtract } from "../features/subtract.js";
import { SceneObject } from "../common/scene-object.js";
import { ISceneObject } from "./interfaces.js";

interface SubtractFunction {
  /**
   * Subtracts the second shape from the first (boolean difference).
   * @param object1 - The base shape
   * @param object2 - The shape to subtract
   */
  (object1: ISceneObject, object2: ISceneObject): ISceneObject;
}

function build(context: SceneParserContext): SubtractFunction {
  return function subtract(object1: ISceneObject, object2: ISceneObject): ISceneObject {
    if (context.getActiveSketch()) {
      throw new Error("subtract() is no longer available inside a sketch — 2D booleans were removed");
    }

    const subtract = new Subtract(object1 as SceneObject, object2 as SceneObject);
    context.addSceneObject(subtract);
    return subtract;
  }
}

export default registerBuilder(build);
