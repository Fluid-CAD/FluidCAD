import { Shell } from "../features/shell.js";
import { registerBuilder, SceneParserContext } from "../index.js";

function build(context: SceneParserContext) {
  return function shell(thickness: number = 2.5) {
    const selection = context.getLastSelection();
    const shell = new Shell(selection, thickness);
    context.addSceneObject(shell);
    return shell;
  }
}

export default registerBuilder(build);
