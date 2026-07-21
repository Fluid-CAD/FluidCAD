import { registerBuilder, SceneParserContext } from "../index.js";
import { SceneObject } from "../common/scene-object.js";
import { Color } from "../features/color.js";
import { ISceneObject } from "./interfaces.js";
import { type StringParam, resolveParam } from "./param.js";

interface ColorFunction {
  /**
   * Applies a color to the last selection, or to every face in the current
   * context when there is no selection (equivalent to `select(face())` first).
   * @param color - The color value (CSS color string)
   */
  (color: StringParam): ISceneObject;
  /**
   * Applies a color to the given selection or object.
   * @param color - The color value (CSS color string)
   * @param selection - A face selection, or any scene object — every face of
   * the object's solids is colored
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

    if (selection) {
      context.addSceneObject(selection);
    }
    const obj = new Color(resolveParam(arguments[0] as StringParam), selection);

    context.addSceneObject(obj);
    return obj;
  }
}

export default registerBuilder(build);
