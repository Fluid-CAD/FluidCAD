import { registerBuilder, SceneParserContext } from "../index.js";
import { SceneObject } from "../common/scene-object.js";
import { Color } from "../features/color.js";

interface ColorFunction {
  (color: string): Color;
}

function build(context: SceneParserContext): ColorFunction {
  return function color() {
    const obj = new Color(arguments[0]);

    const selection = context.getLastSelection();
    if (selection) {
      obj.target(selection);
    }

    context.addSceneObject(obj);
    return obj;
  }
}

export default registerBuilder(build);
