import { Text } from "../../features/2d/text.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { isPlaneLike, PlaneLike } from "../../math/plane.js";
import { SceneObject } from "../../common/scene-object.js";
import { resolvePlane } from "../../helpers/resolve.js";
import { IText, ISceneObject } from "../interfaces.js";

interface TextFunction {
  /**
   * Renders a text string as extrudable outline geometry inside the current
   * sketch, at the sketch cursor.
   * @param text - The string to render.
   */
  (text: string): IText;
  /**
   * Renders a text string on a specific plane (standalone, outside a sketch).
   * @param plane - The plane (e.g. "xy") or face to render the text on.
   * @param text - The string to render.
   */
  (plane: PlaneLike | ISceneObject, text: string): IText;
}

function build(context: SceneParserContext): TextFunction {
  return function text(): IText {
    const first = arguments[0];
    // A leading plane/face is only valid standalone and only when a string
    // follows it; `text("xy")` (one arg) renders the literal string "xy".
    const standalone = arguments.length >= 2 && (isPlaneLike(first) || first instanceof SceneObject);

    if (standalone) {
      if (context.getActiveSketch() !== null) {
        throw new Error("text(plane, ...) cannot be used inside a sketch. Use text(...) instead.");
      }
      const planeObj = resolvePlane(first, context);
      const obj = new Text(String(arguments[1] ?? ""), planeObj);
      context.addSceneObject(obj);
      return obj;
    }

    const obj = new Text(String(first ?? ""));
    context.addSceneObject(obj);
    return obj;
  } as TextFunction;
}

export default registerBuilder(build);
