import { Shell } from "../features/shell.js";
import { SceneObject } from "../common/scene-object.js";
import { SelectSceneObject } from "../features/select.js";
import { registerBuilder, SceneParserContext } from "../index.js";
import { ISceneObject } from "./interfaces.js";

interface ShellFunction {
  (thickness?: number): ISceneObject;
  (thickness: number, selection: ISceneObject): ISceneObject;
}

function build(context: SceneParserContext): ShellFunction {
  return function shell() {
    const args = Array.from(arguments);

    let selection: SelectSceneObject | undefined;
    if (args.length > 0 && args[args.length - 1] instanceof SceneObject) {
      selection = args.pop() as SelectSceneObject;
    } else {
      selection = context.getLastSelection() || undefined;
    }

    const thickness = (args.length >= 1 && typeof args[0] === 'number')
      ? args[0] as number
      : 2.5;

    const shell = new Shell(thickness, selection);

    context.addSceneObject(shell);
    return shell;
  } as ShellFunction;
}

export default registerBuilder(build);
