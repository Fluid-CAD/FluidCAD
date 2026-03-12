import { Point2DLike, isPoint2DLike } from "../../math/point.js";
import { TangentArc } from "../../features/2d/tarc.js";
import { TangentArcToPoint } from "../../features/2d/tarc-to-point.js";
import { TangentArcToPointTangent } from "../../features/2d/tarc-to-point-tangent.js";
import { TangentArcTwoObjects } from "../../features/2d/tarc-two-circles.js";
import { TangentArcWithTangent } from "../../features/2d/tarc-with-tangent.js";
import { Move } from "../../features/2d/move.js";
import { normalizePoint2D } from "../../helpers/normalize.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { SceneObject } from "../../common/scene-object.js";
import { QualifiedSceneObject } from "../../features/2d/constraints/qualified-geometry.js";

interface TArcFunction {
  (radius?: number, endAngle?: number): TangentArc;
  (radius: number, angle: number, tangent: Point2DLike): TangentArcWithTangent;
  (endPoint: Point2DLike): TangentArcToPoint;
  (endPoint: Point2DLike, tangent: Point2DLike): TangentArcToPointTangent;
  (startPoint: Point2DLike, endPoint: Point2DLike, tangent: Point2DLike): TangentArcToPointTangent;
  (c1: SceneObject | QualifiedSceneObject | Point2DLike, c2: SceneObject | QualifiedSceneObject | Point2DLike, radius: number): TangentArcTwoObjects;
}

function build(context: SceneParserContext): TArcFunction {
  return function tarc() {
    // tarc(c1, c2, radius): fillet arc tangent to two circles/points
    if (arguments.length === 3 &&
      (arguments[0] instanceof SceneObject || arguments[0] instanceof QualifiedSceneObject) &&
      typeof arguments[2] === 'number') {
      const o1 = isPoint2DLike(arguments[0]) ? normalizePoint2D(arguments[0] as Point2DLike) : arguments[0]
      const o2 = isPoint2DLike(arguments[1]) ? normalizePoint2D(arguments[1] as Point2DLike) : arguments[1]
      const c1 = QualifiedSceneObject.from(o1);
      const c2 = QualifiedSceneObject.from(o2);

      const radius = arguments[2] as number;
      const arc = new TangentArcTwoObjects(c1, c2, radius);
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
