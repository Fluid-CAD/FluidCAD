import { Draft } from "../features/draft.js";
import { SceneObject } from "../common/scene-object.js";
import { SelectSceneObject } from "../features/select.js";
import { registerBuilder, SceneParserContext } from "../index.js";
import { ISceneObject, IDraft } from "./interfaces.js";
import { rad } from "../helpers/math-helpers.js";

interface DraftFunction {
  /**
   * Applies a draft angle to the last selected faces.
   * @param angle - The draft angle in degrees
   */
  (angle: number): IDraft;
  /**
   * Applies a draft angle to the given face selections.
   * @param angle - The draft angle in degrees
   * @param selections - The face selections to draft
   */
  (angle: number, ...selections: ISceneObject[]): IDraft;
}

function build(context: SceneParserContext): DraftFunction {
  return function draft() {
    const args = Array.from(arguments);

    const selections: SceneObject[] = [];
    while (args.length > 0 && args[args.length - 1] instanceof SceneObject) {
      selections.unshift(args.pop() as SceneObject);
    }

    if (selections.length === 0) {
      const implicit = context.getLastSelection() || undefined;
      if (implicit) {
        selections.push(implicit);
      }
    }

    const angleDeg = (args.length >= 1 && typeof args[0] === 'number')
      ? args[0] as number
      : 5;

    for (const sel of selections) {
      context.addSceneObject(sel);
    }

    const draft = new Draft(rad(angleDeg), selections);

    context.addSceneObject(draft);
    return draft;
  } as DraftFunction;
}

export default registerBuilder(build);
