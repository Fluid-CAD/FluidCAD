import { registerBuilder, SceneParserContext } from "../index.js";
import { SceneObject } from "../common/scene-object.js";
import { Color } from "../features/color.js";
import { ISceneObject } from "./interfaces.js";
import { type StringParam, resolveParam } from "./param.js";

interface ColorFunction {
  /**
   * Applies a color to the last selection.
   * @param color - The color value (CSS color string)
   */
  (color: StringParam): ISceneObject;
  /**
   * Applies a color to the given selection.
   * @param color - The color value (CSS color string)
   * @param selection - The face or edge selection to color
   */
  (color: StringParam, selection: ISceneObject): ISceneObject;
}

function build(context: SceneParserContext): ColorFunction {
  return function color() {
    let selection: SceneObject | undefined;
    if (arguments.length >= 2 && arguments[1] instanceof SceneObject) {
      selection = arguments[1] as SceneObject;
    } else {
      selection = context.getLastSelection() || undefined;
    }

    context.addSceneObject(selection);
    const obj = new Color(resolveParam(arguments[0] as StringParam), selection);

    context.addSceneObject(obj);
    return obj;
  }
}

export default registerBuilder(build);
