import { Point2DLike, isPoint2DLike } from "../../math/point.js";
import { Circle } from "../../features/2d/circle.js";
import { Move } from "../../features/2d/move.js";
import { normalizePoint2D } from "../../helpers/normalize.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { LazyVertex } from "../../features/lazy-vertex.js";
import { PlaneObjectBase } from "../../features/plane-renderable-base.js";
import { isPlaneLike, PlaneLike } from "../../math/plane.js";
import { SceneObject } from "../../common/scene-object.js";
import { resolvePlane } from "../../helpers/resolve.js";
import { IExtrudableGeometry, ISceneObject } from "../interfaces.js";

interface CircleFunction {
  /**
   * Draws a circle at a given center with an optional diameter.
   * @param center - The center point
   * @param diameter - The circle diameter (defaults to 40)
   */
  (center: Point2DLike, diameter?: number): IExtrudableGeometry;
  /**
   * Draws a circle at the origin with an optional diameter.
   * @param diameter - The circle diameter (defaults to 40)
   */
  (diameter?: number): IExtrudableGeometry;
  /**
   * Draws a circle with a given diameter on a specific plane.
   * @param targetPlane - The plane to draw on
   * @param diameter - The circle diameter
   */
  (targetPlane: PlaneLike | ISceneObject, diameter: number): IExtrudableGeometry;
}

function build(context: SceneParserContext): CircleFunction {
  return function circle() {
    let diameter: number;
    let center: LazyVertex;
    let circle: Circle;
    let planeObj: PlaneObjectBase | null = null;
    let argOffset = 0;

    // Detect plane as first argument (only valid outside a sketch)
    if (arguments.length > 0) {
      const firstArg = arguments[0];
      if (isPlaneLike(firstArg) || (firstArg instanceof SceneObject && !isPoint2DLike(firstArg))) {
        if (context.getActiveSketch() !== null) {
          throw new Error("circle(plane, ...) cannot be used inside a sketch. Use circle(...) instead.");
        }
        planeObj = resolvePlane(firstArg, context);
        argOffset = 1;
      }
    }

    const argCount = arguments.length - argOffset;

    if (argCount === 0) {
      diameter = 40;
      circle = new Circle(diameter, null, planeObj);
      context.addSceneObject(circle);
    }
    else if (argCount === 1) {
      diameter = arguments[argOffset] as number || 40;
      circle = new Circle(diameter, null, planeObj);
      context.addSceneObject(circle);
    }
    else {
      center = normalizePoint2D(arguments[argOffset]);
      diameter = arguments[argOffset + 1] as number || 40;
      circle = new Circle(diameter, null, planeObj);
      const move = new Move(center);
      context.addSceneObjects([move, circle]);
    }

    return circle;
  } as CircleFunction;
}

export default registerBuilder(build);
