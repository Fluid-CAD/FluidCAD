import { Point2DLike, isPoint2DLike } from "../../math/point.js";
import { TangentArc } from "../../features/2d/tarc.js";
import { TangentArcToPoint } from "../../features/2d/tarc-to-point.js";
import { TangentArcToPointTangent } from "../../features/2d/tarc-to-point-tangent.js";
import { Move } from "../../features/2d/move.js";
import { normalizePoint2D } from "../../helpers/normalize.js";
import { registerBuilder, SceneParserContext } from "../../index.js";

interface TArcFunction {
  (radius?: number, endAngle?: number): TangentArc;
  (endPoint: Point2DLike): TangentArcToPoint;
  (endPoint: Point2DLike, tangent: Point2DLike): TangentArcToPointTangent;
  (startPoint: Point2DLike, endPoint: Point2DLike, tangent: Point2DLike): TangentArcToPointTangent;
}

function build(context: SceneParserContext): TArcFunction {
  return function tarc() {
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

    const arc = new TangentArc(radius, endAngle);
    context.addSceneObject(arc);

    return arc;
  } as TArcFunction;
}

export default registerBuilder(build);
