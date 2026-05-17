import { Point2DLike, isPoint2DLike } from "../../math/point.js";
import { TangentArc } from "../../features/2d/tarc.js";
import { TangentArcToPoint } from "../../features/2d/tarc-to-point.js";
import { TangentArcToPointTangent } from "../../features/2d/tarc-to-point-tangent.js";
import { TangentArcWithTangent } from "../../features/2d/tarc-with-tangent.js";
import { TangentArcToObject } from "../../features/2d/tarc-to-object.js";
import { TangentArcRadiusToObject } from "../../features/2d/tarc-radius-to-object.js";
import { Move } from "../../features/2d/move.js";
import { normalizePoint2D } from "../../helpers/normalize.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { QualifiedSceneObject } from "../../features/2d/constraints/qualified-geometry.js";
import { TangentArcTwoObjects } from "../../features/2d/tarc-constrained.js";
import { IGeometry, ISceneObject, ITangentArcToObject, ITangentArcTwoObjects } from "../interfaces.js";
import { SceneObject } from "../../common/scene-object.js";

interface TArcFunction {
  /**
   * Draws a tangent arc from the current position using the current tangent
   * direction, ending tangent to a target line. The radius is solved
   * automatically; the arc must be tangent to the target but does not need
   * to touch its finite extent. By default the arc curves to the left of
   * the start tangent — chain `.flip()` to curve to the right instead.
   * @param target - The target line (or a qualified line)
   */
  (target: ISceneObject | QualifiedSceneObject): ITangentArcToObject;
  /**
   * Draws a tangent arc from the current position using the current tangent
   * direction, with the given radius, ending at the first intersection with
   * the target geometry along the arc's sweep direction. A negative radius
   * flips the sweep direction. Supported targets: lines, circles, and arcs.
   * @param radius - The arc radius. A negative value flips the sweep direction.
   * @param target - The target geometry to intersect with
   */
  (radius: number, target: ISceneObject | QualifiedSceneObject): IGeometry;
  /**
   * Draws a tangent arc with a given radius and end angle.
   * @param radius - The arc radius (defaults to 100). A negative value flips the sweep direction.
   * @param endAngle - The sweep angle in degrees (defaults to 90)
   */
  (radius?: number, endAngle?: number): IGeometry;
  /**
   * Draws a tangent arc with a given radius, angle, and start tangent direction.
   * @param radius - The arc radius. A negative value flips the sweep direction.
   * @param angle - The sweep angle in degrees
   * @param tangent - The start tangent direction
   */
  (radius: number, angle: number, tangent: Point2DLike): IGeometry;
  /**
   * Draws a tangent arc to a given end point.
   * @param endPoint - The end point of the arc
   */
  (endPoint: Point2DLike): IGeometry;
  /**
   * Draws a tangent arc to a given end point with an explicit end tangent.
   * @param endPoint - The end point of the arc
   * @param tangent - The end tangent direction
   */
  (endPoint: Point2DLike, tangent: Point2DLike): IGeometry;
  /**
   * Draws a tangent arc from a start point to an end point with a tangent.
   * @param startPoint - The start point of the arc
   * @param endPoint - The end point of the arc
   * @param tangent - The end tangent direction
   */
  (startPoint: Point2DLike, endPoint: Point2DLike, tangent: Point2DLike): IGeometry;
  /**
   * Draws all possible tangent arcs between two geometry objects.
   * @param c1 - The first geometry object
   * @param c2 - The second geometry object
   * @param radius - The arc radius
   * @param mustTouch - Whether the arc must touch both objects
   */
  (c1: ISceneObject, c2: ISceneObject, radius: number, mustTouch?: boolean): ITangentArcTwoObjects;
  /**
   * Draws a tangent arc between two qualified geometry objects.
   * @param c1 - The first qualified geometry object (e.g., `outside(circle1)`)
   * @param c2 - The second qualified geometry object
   * @param radius - The arc radius
   * @param mustTouch - Whether the arc must touch both objects
   */
  (c1: QualifiedSceneObject, c2: QualifiedSceneObject, radius: number, mustTouch?: boolean): ITangentArcTwoObjects;
  /**
   * Draws a tangent arc between two points.
   * @param c1 - The first point
   * @param c2 - The second point
   * @param radius - The arc radius
   * @param mustTouch - Whether the arc must touch both points
   */
  (c1: Point2DLike, c2: Point2DLike, radius: number, mustTouch?: boolean): ITangentArcTwoObjects;
  /**
   * Draws a tangent arc using a mix of geometry objects, qualified objects, or points as constraints.
   * @param c1 - The first constraint object or point
   * @param c2 - The second constraint object or point
   * @param radius - The arc radius
   * @param mustTouch - Whether the arc must touch both constraints
   */
  (c1: ISceneObject | QualifiedSceneObject | Point2DLike, c2: ISceneObject | QualifiedSceneObject | Point2DLike, radius: number, mustTouch?: boolean): ITangentArcTwoObjects;
}

function build(context: SceneParserContext): TArcFunction {
  return function tarc() {
    // tArc(target): single scene-object target, radius solved automatically
    if (
      arguments.length === 1 &&
      (arguments[0] instanceof SceneObject || arguments[0] instanceof QualifiedSceneObject)
    ) {
      const target = QualifiedSceneObject.from(arguments[0]);
      const arc = new TangentArcToObject(target);
      context.addSceneObject(arc);
      return arc;
    }

    // tArc(radius, target): explicit radius, end at first intersection with target
    if (
      arguments.length === 2 &&
      typeof arguments[0] === 'number' &&
      (arguments[1] instanceof SceneObject || arguments[1] instanceof QualifiedSceneObject)
    ) {
      const radius = arguments[0] as number;
      const target = QualifiedSceneObject.from(arguments[1]);
      const arc = new TangentArcRadiusToObject(radius, target);
      context.addSceneObject(arc);
      return arc;
    }

    // tarc(c1, c2, radius): fillet arc tangent to two circles/points
    if ((arguments.length === 3 || arguments.length === 4) && typeof arguments[2] === 'number') {
      const o1 = isPoint2DLike(arguments[0]) ? normalizePoint2D(arguments[0] as Point2DLike) : arguments[0]
      const o2 = isPoint2DLike(arguments[1]) ? normalizePoint2D(arguments[1] as Point2DLike) : arguments[1]
      const c1 = QualifiedSceneObject.from(o1);
      const c2 = QualifiedSceneObject.from(o2);

      const radius = arguments[2] as number;
      const mustTouch = typeof arguments[3] === 'boolean' ? arguments[3] : false;
      const arc = new TangentArcTwoObjects(c1, c2, radius, mustTouch);
      context.addSceneObject(arc);
      return arc;
    }

    if (arguments.length > 0 && isPoint2DLike(arguments[0])) {
      // 3 Point2DLike args: tArc(startPoint, endPoint, tangent)
      if (arguments.length > 2 && isPoint2DLike(arguments[1]) && isPoint2DLike(arguments[2])) {
        const startPoint = normalizePoint2D(arguments[0] as Point2DLike);
        const endPoint = normalizePoint2D(arguments[1] as Point2DLike);
        const tangent = normalizePoint2D(arguments[2] as Point2DLike);
        const arc = new TangentArcToPointTangent(endPoint, tangent);
        context.addSceneObjects([new Move(startPoint), arc]);
        return arc;
      }

      const endPoint = normalizePoint2D(arguments[0] as Point2DLike);

      // 2 Point2DLike args: tArc(endPoint, tangent)
      if (arguments.length > 1 && isPoint2DLike(arguments[1])) {
        const tangent = normalizePoint2D(arguments[1] as Point2DLike);
        const arc = new TangentArcToPointTangent(endPoint, tangent);
        context.addSceneObject(arc);
        return arc;
      }

      const arc = new TangentArcToPoint(endPoint);
      context.addSceneObject(arc);
      return arc;
    }

    const radius = arguments[0] as number || 100;
    const endAngle = arguments[1] as number || 90;

    // tArc(radius, angle, tangent): explicit start tangent instead of reading from previous sibling
    if (arguments.length === 3 && isPoint2DLike(arguments[2])) {
      const tangent = normalizePoint2D(arguments[2] as Point2DLike);
      const arc = new TangentArcWithTangent(radius, endAngle, tangent);
      context.addSceneObject(arc);
      return arc;
    }

    const arc = new TangentArc(radius, endAngle);
    context.addSceneObject(arc);

    return arc;
  } as TArcFunction;
}

export default registerBuilder(build);
