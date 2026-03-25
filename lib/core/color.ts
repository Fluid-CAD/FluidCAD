import { registerBuilder, SceneParserContext } from "../index.js";
import { SceneObject } from "../common/scene-object.js";
import { Color } from "../features/color.js";
import { ISceneObject } from "./interfaces.js";

interface ColorFunction {
  (color: string): ISceneObject;
  (color: string, selection: ISceneObject): ISceneObject;
}

function build(context: SceneParserContext): ColorFunction {
  return function color() {
    let selection: SceneObject | undefined;
    if (arguments.length >= 2 && arguments[1] instanceof SceneObject) {
      selection = arguments[1] as SceneObject;
    } else {
      selection = context.getLastSelection() || undefined;
    }

    const obj = new Color(arguments[0], selection);

    context.addSceneObject(obj);
    return obj;
  }
}

export default registerBuilder(build);
