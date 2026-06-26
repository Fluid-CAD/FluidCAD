import { Point2DLike } from "../../math/point.js";
import { Circle } from "../../features/2d/circle.js";
import { Move } from "../../features/2d/move.js";
import { normalizePoint2D } from "../../helpers/normalize.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { LazyVertex } from "../../features/lazy-vertex.js";
import { IExtrudableGeometry } from "../interfaces.js";
import { type NumberParam, resolveParam } from "../param.js";

interface CircleFunction {
  /**
   * Draws a circle at a given center with an optional diameter.
   * @param center - The center point
   * @param diameter - The circle diameter (defaults to 40)
   */
  (center: Point2DLike, diameter?: NumberParam): IExtrudableGeometry;
  /**
   * Draws a circle at the origin with an optional diameter.
   * @param diameter - The circle diameter (defaults to 40)
   */
  (diameter?: NumberParam): IExtrudableGeometry;
}

function build(context: SceneParserContext): CircleFunction {
  return function circle() {
    let diameter: number;
    let center: LazyVertex;
    let circle: Circle;

    const argCount = arguments.length;

    if (argCount === 0) {
      diameter = 40;
      circle = new Circle(diameter, null, null);
      context.addSceneObject(circle);
    }
    else if (argCount === 1) {
      diameter = resolveParam(arguments[0] as NumberParam) || 40;
      circle = new Circle(diameter, null, null);
      context.addSceneObject(circle);
    }
    else {
      center = normalizePoint2D(arguments[0]);
      diameter = resolveParam(arguments[1] as NumberParam) || 40;
      circle = new Circle(diameter, null, null);
      const move = new Move(center);
      context.addSceneObjects([move, circle]);
    }

    return circle;
  } as CircleFunction;
}

export default registerBuilder(build);
