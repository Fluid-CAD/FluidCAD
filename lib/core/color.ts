import { registerBuilder, SceneParserContext } from "../index.js";
import { SceneObject } from "../common/scene-object.js";
import { Color } from "../features/color.js";

interface ColorFunction {
  (face: SceneObject, color: string): Color;
}

function build(context: SceneParserContext): ColorFunction {
  return function color() {
    const obj = new Color(arguments[0], arguments[1]);
    context.addSceneObject(obj);
    return obj;
  }
}

export default registerBuilder(build);
