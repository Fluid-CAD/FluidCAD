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
   * Applies a color to the given selections or objects — any mix of face
   * selections and scene objects; every face of an object's solids is colored.
   * @param color - The color value (CSS color string)
   * @param selections - Face selections, or any scene objects
   */
  (color: StringParam, ...selections: ISceneObject[]): ISceneObject;
}

function build(context: SceneParserContext): ColorFunction {
  return function color() {
    const explicit = Array.from(arguments).slice(1).filter((arg): arg is SceneObject => arg instanceof SceneObject);
    let selections: SceneObject[] = explicit;
    if (explicit.length === 0) {
      // A bare color() takes the last unclaimed selection and claims it: a
      // bare fillet(2) after it must not inherit a face selection (D1).
      const implicit = context.getLastSelection();
      if (implicit) {
        implicit.markClaimed();
        selections = [implicit];
      }
    }

    for (const selection of selections) {
      context.addSceneObject(selection);
    }
    const obj = new Color(resolveParam(arguments[0] as StringParam), selections);

    context.addSceneObject(obj);
    return obj;
  }
}

export default registerBuilder(build);
