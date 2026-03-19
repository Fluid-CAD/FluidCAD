import { Shell } from "../features/shell.js";
import { registerBuilder, SceneParserContext } from "../index.js";

function build(context: SceneParserContext) {
  return function shell(thickness: number = 2.5) {
    const shell = new Shell(thickness);

    const selection = context.getLastSelection();
    if (selection) {
      shell.target(selection);
    }

    context.addSceneObject(shell);
    return shell;
  }
}

export default registerBuilder(build);
