import { Point2DLike } from "../../math/point.js";
import { Ellipse } from "../../features/2d/ellipse.js";
import { normalizePoint2D } from "../../helpers/normalize.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { IEllipse } from "../interfaces.js";
import { type NumberParam, resolveParam } from "../param.js";

interface EllipseFunction {
  /**
   * Draws an ellipse at a given center. The center is a solver point —
   * `.center()` references it in constraints, so the solve positions the
   * ellipse; the radii stay fixed literals.
   * @param center - The center point
   * @param rx - Semi-radius along the plane's X axis
   * @param ry - Semi-radius along the plane's Y axis
   */
  (center: Point2DLike, rx: NumberParam, ry: NumberParam): IEllipse;
}

function build(context: SceneParserContext): EllipseFunction {
  return function ellipse() {
    if (arguments.length !== 3) {
      throw new Error(
        "ellipse() needs an explicit center — the pen-anchored form was removed; " +
        "write ellipse([x, y], rx, ry)",
      );
    }
    const center = normalizePoint2D(arguments[0]);
    const rx = resolveParam(arguments[1] as NumberParam);
    const ry = resolveParam(arguments[2] as NumberParam);
    const e = new Ellipse(rx, ry, null, center.asPoint2D());
    context.addSceneObject(e);
    const activeSketch = context.getActiveSketch();
    if (activeSketch) {
      e.register(activeSketch);
    }
    return e;
  } as EllipseFunction;
}

export default registerBuilder(build);
