import { Point2DLike } from "../../math/point.js";
import { Ellipse } from "../../features/2d/ellipse.js";
import { normalizePoint2D } from "../../helpers/normalize.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { IEllipse } from "../interfaces.js";
import { type NumberParam, resolveParam } from "../param.js";

interface EllipseFunction {
  /**
   * Draws an ellipse at a given center. The ellipse is a solver entity like
   * a circle: every literal is a guess the constraints drive — the center
   * (`coincident`, `concentric`, …), the rotation of its RX axis
   * (`horizontal`/`vertical`, `tangent`) and the two semi-radii
   * (`radius(el, v, 'x')` for RX, `radius(el, v, 'y')` for RY). `rx` runs
   * along the ellipse's own RX axis, which starts along the plane's X
   * direction.
   * @param center - The center point (a guess, like every literal)
   * @param rx - Semi-radius guess along the ellipse's RX axis
   * @param ry - Semi-radius guess along the ellipse's RY axis
   * @param rotation - Guess for the RX axis's angle from the plane's X
   *   direction, degrees (default 0)
   */
  (center: Point2DLike, rx: NumberParam, ry: NumberParam, rotation?: NumberParam): IEllipse;
}

function build(context: SceneParserContext): EllipseFunction {
  return function ellipse() {
    if (arguments.length < 3 || arguments.length > 4) {
      throw new Error(
        "ellipse() needs an explicit center — the pen-anchored form was removed; " +
        "write ellipse([x, y], rx, ry) or ellipse([x, y], rx, ry, rotation)",
      );
    }
    const center = normalizePoint2D(arguments[0]);
    const rx = resolveParam(arguments[1] as NumberParam);
    const ry = resolveParam(arguments[2] as NumberParam);
    const rotation = arguments.length === 4 ? resolveParam(arguments[3] as NumberParam) : null;
    if (rotation !== null && !Number.isFinite(rotation)) {
      throw new Error("ellipse(): rotation must be a finite number of degrees");
    }
    const e = new Ellipse(center.asPoint2D(), rx, ry, rotation);
    context.addSceneObject(e);
    const activeSketch = context.getActiveSketch();
    if (activeSketch) {
      e.register(activeSketch);
    }
    return e;
  } as EllipseFunction;
}

export default registerBuilder(build);
