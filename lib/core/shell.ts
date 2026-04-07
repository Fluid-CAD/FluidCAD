import { Shell } from "../features/shell.js";
import { SceneObject } from "../common/scene-object.js";
import { SelectSceneObject } from "../features/select.js";
import { registerBuilder, SceneParserContext } from "../index.js";
import { ISceneObject, IShell } from "./interfaces.js";

interface ShellFunction {
  /**
   * Hollows out a solid with the given wall thickness.
   * @param thickness - The wall thickness (defaults to 2.5)
   */
  (thickness?: number): IShell;
  /**
   * Hollows out a solid, removing the selected faces.
   * @param thickness - The wall thickness
   * @param selections - The face selections to remove
   */
  (thickness: number, ...selections: ISceneObject[]): IShell;
}

function build(context: SceneParserContext): ShellFunction {
  return function shell() {
    const args = Array.from(arguments);

    const selections: SelectSceneObject[] = [];
    while (args.length > 0 && args[args.length - 1] instanceof SceneObject) {
      selections.unshift(args.pop() as SelectSceneObject);
    }

    if (selections.length === 0) {
      const implicit = context.getLastSelection() || undefined;
      if (implicit) {
        selections.push(implicit);
      }
    }

    const thickness = (args.length >= 1 && typeof args[0] === 'number')
      ? args[0] as number
      : 2.5;

    for (const sel of selections) {
      context.addSceneObject(sel);
    }

    const shell = new Shell(thickness, selections.length > 0 ? selections : undefined);

    context.addSceneObject(shell);
    return shell;
  } as ShellFunction;
}

export default registerBuilder(build);
