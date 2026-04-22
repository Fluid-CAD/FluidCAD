
import { registerBuilder, SceneParserContext } from "../index.js";
import { Subtract } from "../features/subtract.js";
import { Subtract2D } from "../features/subtract2d.js";
import { SceneObject } from "../common/scene-object.js";
import { GeometrySceneObject } from "../features/2d/geometry.js";
import { ISceneObject, ITransformable } from "./interfaces.js";

interface SubtractFunction {
  /**
   * Subtracts the second shape from the first (boolean difference).
   * Works with both 3D solids and 2D sketch geometries.
   * @param object1 - The base shape
   * @param object2 - The shape to subtract
   */
  (object1: ISceneObject, object2: ISceneObject): ITransformable;
}

function build(context: SceneParserContext): SubtractFunction {
  return function subtract(object1: ISceneObject, object2: ISceneObject): ITransformable {
    const activeSketch = context.getActiveSketch();

    if (activeSketch) {
      const subtract2d = new Subtract2D(object1 as GeometrySceneObject, object2 as GeometrySceneObject);
      context.addSceneObject(subtract2d);
      return subtract2d;
    }

    const subtract = new Subtract(object1 as SceneObject, object2 as SceneObject);
    context.addSceneObject(subtract);
    return subtract;
  }
}

export default registerBuilder(build);
