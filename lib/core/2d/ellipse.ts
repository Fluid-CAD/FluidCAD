import { Point2DLike } from "../../math/point.js";
import { Ellipse } from "../../features/2d/ellipse.js";
import { Move } from "../../features/2d/move.js";
import { normalizePoint2D } from "../../helpers/normalize.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { IExtrudableGeometry } from "../interfaces.js";
import { type NumberParam, resolveParam } from "../param.js";

interface EllipseFunction {
  /**
   * Draws an ellipse at the current position.
   * @param rx - Semi-radius along the plane's X axis
   * @param ry - Semi-radius along the plane's Y axis
   */
  (rx: NumberParam, ry: NumberParam): IExtrudableGeometry;
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
    const argCount = arguments.length;

    if (argCount === 2) {
      const rx = resolveParam(arguments[0] as NumberParam);
      const ry = resolveParam(arguments[1] as NumberParam);
      const e = new Ellipse(rx, ry, null);
      context.addSceneObject(e);
      return e;
    }

    if (argCount === 3) {
      const centerArg = arguments[0];
      const rx = resolveParam(arguments[1] as NumberParam);
      const ry = resolveParam(arguments[2] as NumberParam);

      const center = normalizePoint2D(centerArg);
      const e = new Ellipse(rx, ry, null);
      context.addSceneObjects([new Move(center), e]);
      return e;
    }

    throw new Error("Invalid arguments for ellipse()");
  } as EllipseFunction;
}

export default registerBuilder(build);
