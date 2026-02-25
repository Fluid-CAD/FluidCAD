import { TangentLine } from "../../features/2d/tline.js";
import { registerBuilder, SceneParserContext } from "../../index.js";

interface TLineFunction {
  (distance: number): TangentLine;
}

function build(context: SceneParserContext): TLineFunction {
  return function line() {
    const distance: number = arguments[0];

    const hline = new TangentLine(distance);
    context.addSceneObject(hline);

    return hline;
  }
}

export default registerBuilder(build);
