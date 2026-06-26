import { Point2DLike } from "../../math/point.js";
import { Polygon, PolygonMode } from "../../features/2d/polygon.js";
import { Move } from "../../features/2d/move.js";
import { normalizePoint2D } from "../../helpers/normalize.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { LazyVertex } from "../../features/lazy-vertex.js";
import { IPolygon } from "../interfaces.js";
import { type NumberParam, isNumberParam, resolveParam } from "../param.js";

interface PolygonFunction {
  /**
   * Draws a regular polygon with the given number of sides and diameter.
   * @param numberOfSides - The number of sides
   * @param diameter - The circumscribed or inscribed diameter
   * @param mode - `'inscribed'` or `'circumscribed'` (defaults to `'inscribed'`)
   */
  (numberOfSides: NumberParam, diameter: NumberParam, mode?: PolygonMode): IPolygon;
  /**
   * Draws a regular polygon at a given center point.
   * @param center - The center point
   * @param numberOfSides - The number of sides
   * @param diameter - The circumscribed or inscribed diameter
   * @param mode - `'inscribed'` or `'circumscribed'` (defaults to `'inscribed'`)
   */
  (center: Point2DLike, numberOfSides: NumberParam, diameter: NumberParam, mode?: PolygonMode): IPolygon;
}

function build(context: SceneParserContext): PolygonFunction {
  return function polygon() {
    let numberOfSides: number;
    let diameter: number;
    let mode: PolygonMode;
    let center: LazyVertex;
    let poly: Polygon;

    const argCount = arguments.length;

    if (argCount === 2) {
      numberOfSides = resolveParam(arguments[0] as NumberParam);
      diameter = resolveParam(arguments[1] as NumberParam);
      mode = 'inscribed';

      poly = new Polygon(numberOfSides, diameter, mode, null);
      context.addSceneObject(poly);
    }
    else if (argCount === 3) {
      if (isNumberParam(arguments[0])) {
        numberOfSides = resolveParam(arguments[0] as NumberParam);
        diameter = resolveParam(arguments[1] as NumberParam);
        mode = arguments[2] as PolygonMode;

        poly = new Polygon(numberOfSides, diameter, mode, null);
        context.addSceneObject(poly);
      } else {
        center = normalizePoint2D(arguments[0]);
        numberOfSides = resolveParam(arguments[1] as NumberParam);
        diameter = resolveParam(arguments[2] as NumberParam);
        mode = 'inscribed';

        poly = new Polygon(numberOfSides, diameter, mode, null);
        context.addSceneObjects([new Move(center), poly]);
      }
    }
    else if (argCount === 4) {
      center = normalizePoint2D(arguments[0]);
      numberOfSides = resolveParam(arguments[1] as NumberParam);
      diameter = resolveParam(arguments[2] as NumberParam);
      mode = arguments[3] as PolygonMode;

      poly = new Polygon(numberOfSides, diameter, mode, null);
      context.addSceneObjects([new Move(center), poly]);
    }

    return poly;
  } as PolygonFunction;
}

export default registerBuilder(build);
