import { Point2DLike, isPoint2DLike } from "../../math/point.js";
import { Polygon, PolygonMode } from "../../features/2d/polygon.js";
import { Move } from "../../features/2d/move.js";
import { normalizePoint2D } from "../../helpers/normalize.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { LazyVertex } from "../../features/lazy-vertex.js";
import { PlaneObjectBase } from "../../features/plane-renderable-base.js";
import { isPlaneLike, PlaneLike } from "../../math/plane.js";
import { SceneObject } from "../../common/scene-object.js";
import { resolvePlane } from "../../helpers/resolve.js";
import { IPolygon, ISceneObject } from "../interfaces.js";
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
  /**
   * Draws a regular polygon on a specific plane.
   * @param targetPlane - The plane to draw on
   * @param numberOfSides - The number of sides
   * @param diameter - The circumscribed or inscribed diameter
   */
  (targetPlane: PlaneLike | ISceneObject, numberOfSides: NumberParam, diameter: NumberParam): IPolygon;
  /**
   * Draws a regular polygon with a given mode on a specific plane.
   * @param targetPlane - The plane to draw on
   * @param numberOfSides - The number of sides
   * @param diameter - The circumscribed or inscribed diameter
   * @param mode - `'inscribed'` or `'circumscribed'`
   */
  (targetPlane: PlaneLike | ISceneObject, numberOfSides: NumberParam, diameter: NumberParam, mode: PolygonMode): IPolygon;
}

function build(context: SceneParserContext): PolygonFunction {
  return function polygon() {
    let numberOfSides: number;
    let diameter: number;
    let mode: PolygonMode;
    let center: LazyVertex;
    let poly: Polygon;
    let planeObj: PlaneObjectBase | null = null;
    let argOffset = 0;

    // Detect plane as first argument (only valid outside a sketch)
    // PolygonMode strings ('inscribed'/'circumscribed') don't overlap with StandardPlane strings
    if (arguments.length > 0) {
      const firstArg = arguments[0];
      if (isPlaneLike(firstArg) || (firstArg instanceof SceneObject && !isPoint2DLike(firstArg))) {
        if (context.getActiveSketch() !== null) {
          throw new Error("polygon(plane, ...) cannot be used inside a sketch. Use polygon(...) instead.");
        }
        planeObj = resolvePlane(firstArg, context);
        context.addSceneObject(planeObj);
        argOffset = 1;
      }
    }

    const argCount = arguments.length - argOffset;

    if (argCount === 2) {
      numberOfSides = resolveParam(arguments[argOffset] as NumberParam);
      diameter = resolveParam(arguments[argOffset + 1] as NumberParam);
      mode = 'inscribed';

      poly = new Polygon(numberOfSides, diameter, mode, planeObj);
      context.addSceneObject(poly);
    }
    else if (argCount === 3) {
      if (isNumberParam(arguments[argOffset])) {
        numberOfSides = resolveParam(arguments[argOffset] as NumberParam);
        diameter = resolveParam(arguments[argOffset + 1] as NumberParam);
        mode = arguments[argOffset + 2] as PolygonMode;

        poly = new Polygon(numberOfSides, diameter, mode, planeObj);
        context.addSceneObject(poly);
      } else {
        center = normalizePoint2D(arguments[argOffset]);
        numberOfSides = resolveParam(arguments[argOffset + 1] as NumberParam);
        diameter = resolveParam(arguments[argOffset + 2] as NumberParam);
        mode = 'inscribed';

        poly = new Polygon(numberOfSides, diameter, mode, planeObj);
        context.addSceneObjects([new Move(center), poly]);
      }
    }
    else if (argCount === 4) {
      center = normalizePoint2D(arguments[argOffset]);
      numberOfSides = resolveParam(arguments[argOffset + 1] as NumberParam);
      diameter = resolveParam(arguments[argOffset + 2] as NumberParam);
      mode = arguments[argOffset + 3] as PolygonMode;

      poly = new Polygon(numberOfSides, diameter, mode, planeObj);
      context.addSceneObjects([new Move(center), poly]);
    }

    return poly;
  } as PolygonFunction;
}

export default registerBuilder(build);
