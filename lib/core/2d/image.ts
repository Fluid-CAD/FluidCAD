import { registerBuilder, SceneParserContext } from "../../index.js";
import { SketchImageStatement, SketchImageOptions } from "../../features/2d/sketch-image.js";
import { ISceneObject } from "../interfaces.js";

interface ImageFunction {
  /**
   * Places a reference picture on the sketch plane — a drawing, photo or
   * scan to trace. The editor draws it faded, under the sketch's own lines,
   * wherever the sketch is shown; nothing geometric reads it (no profile,
   * no solve, no consumption). Write it inside the sketch callback. The
   * sketch toolbar's Image tool writes this statement, and double-clicking
   * its timeline row re-opens the picture's handles.
   * @param src - Image file path, relative to the model file (png, jpeg, webp, gif, bmp).
   * @param options - Size on the plane in document units (`width` and/or
   *   `height` — one is enough, the other follows the picture's aspect),
   *   the centre (`at`, default `[0, 0]`), the turn (`angle`, degrees,
   *   default 0) and how solid it draws (`opacity`, 0…1, default 0.5).
   */
  (src: string, options: SketchImageOptions): ISceneObject;
}

function build(context: SceneParserContext): ImageFunction {
  return function image(src: string, options: SketchImageOptions): ISceneObject {
    const statement = new SketchImageStatement(src, options);
    context.addSceneObject(statement);
    statement.register(context.getActiveSketch());
    return statement;
  } as ImageFunction;
}

export default registerBuilder(build);
