import { Text } from "../../features/2d/text.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { SceneObject } from "../../common/scene-object.js";
import { IText, ISceneObject } from "../interfaces.js";

interface TextFunction {
  /**
   * Renders a text string as extrudable outline geometry inside the current
   * sketch, at the sketch cursor.
   * @param text - The string to render.
   */
  (text: string): IText;
  /**
   * Renders a text string following a planar curve. Each glyph is placed
   * upright along the path's arc length; the text plane is the path's plane.
   * Works inside a sketch (following a curve of that sketch) or standalone.
   * The path is left in place — mark it `.guide()` to keep it out of
   * extruded profiles.
   * @param text - The string to render.
   * @param path - The curve to follow: a sketch curve (line/arc/circle), a
   *   whole sketch, a planar primitive, or a selected edge/edge loop
   *   (e.g. `select(edge().circle())`).
   */
  (text: string, path: ISceneObject): IText;
}

function build(context: SceneParserContext): TextFunction {
  return function text(): IText {
    const first = arguments[0];
    const second = arguments[1];

    // A trailing scene object is a path to follow: `text("Hi", path)`.
    // Valid both standalone and inside a sketch (following a sketch curve).
    if (arguments.length >= 2 && second instanceof SceneObject) {
      if (typeof first !== "string") {
        throw new Error("text: when following a path, the first argument must be the text string.");
      }
      const obj = new Text(first, null, second);
      context.addSceneObject(obj);
      return obj;
    }

    const obj = new Text(String(first ?? ""));
    context.addSceneObject(obj);
    // Anchored text in a sketch registers its anchor as a solver point
    // entity (a chained `.at()` refines the guess before the solve).
    const activeSketch = context.getActiveSketch();
    if (activeSketch) {
      obj.register(activeSketch);
    }
    return obj;
  } as TextFunction;
}

export default registerBuilder(build);
