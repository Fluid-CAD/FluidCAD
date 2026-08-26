import { Point2DLike } from "../../math/point.js";
import { Ellipse } from "../../features/2d/ellipse.js";
import { normalizePoint2D } from "../../helpers/normalize.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { IExtrudableGeometry } from "../interfaces.js";
import { type NumberParam, resolveParam } from "../param.js";

interface EllipseFunction {
  /**
   * Draws an ellipse at a given center.
   * @param center - The center point
   * @param rx - Semi-radius along the plane's X axis
   * @param ry - Semi-radius along the plane's Y axis
   */
  (center: Point2DLike, rx: NumberParam, ry: NumberParam): IExtrudableGeometry;
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
    // The center rides the ellipse itself (a fixed-shape entity,
    // constrainable in a later phase).
    const e = new Ellipse(rx, ry, null, center.asPoint2D());
    context.addSceneObject(e);
    return e;
  } as EllipseFunction;
}

export default registerBuilder(build);
