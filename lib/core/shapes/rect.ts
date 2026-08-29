import { Point2DLike } from "../../math/point.js";
import { RectMacro } from "../../features/2d/solved/macros/rect.js";
import { normalizePoint2D } from "../../helpers/normalize.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { IRect } from "../interfaces.js";

interface RectFunction {
  /**
   * Draws an axis-aligned rectangle as one atomic, self-constrained shape:
   * four lines held together by internal rules (no constraint statements,
   * nothing individually deletable). All arguments are guesses — a bare
   * rect has 4 degrees of freedom; pin and dimension it with external
   * constraints against its accessors (`.bottom()`, `.left().start()`, …).
   * Chain `.centered()` to read `pos` as the center, `.radius(r)` to round
   * the corners (the shared radius joins the guesses as a 5th DOF).
   * @param pos - The bottom-left corner (the rectangle's center with `.centered()`)
   * @param width - The signed width
   * @param height - The signed height; defaults to `width` (a square)
   */
  (pos: Point2DLike, width: number, height?: number): IRect;
}

function build(context: SceneParserContext): RectFunction {
  return function rect() {
    if (arguments.length < 2 || arguments.length > 3) {
      throw new Error("rect() takes a position, a width and an optional height — rect([x, y], w, h?)");
    }
    const width = arguments[1];
    const height = arguments.length === 3 ? arguments[2] : width;
    if (typeof width !== 'number' || !Number.isFinite(width)
      || typeof height !== 'number' || !Number.isFinite(height)) {
      throw new Error("rect() width and height must be finite numbers — rect([x, y], w, h?)");
    }
    const macro = new RectMacro(
      normalizePoint2D(arguments[0]).asPoint2D(),
      width,
      height,
    );
    context.addSceneObject(macro);
    const activeSketch = context.getActiveSketch();
    if (activeSketch) {
      macro.register(activeSketch, () => context.getActiveSketch() === activeSketch);
    }
    return macro as unknown as IRect;
  } as RectFunction;
}

export default registerBuilder(build);
