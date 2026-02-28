import { Point2DLike, isPoint2DLike } from "../../math/point.js";
import { TangentArc, TArcOptions } from "../../features/2d/tarc.js";
import { TangentArcToPoint } from "../../features/2d/tarc-to-point.js";
import { normalizePoint2D } from "../../helpers/normalize.js";
import { registerBuilder, SceneParserContext } from "../../index.js";

interface TArcFunction {
  (radius?: number, endAngle?: number, options?: TArcOptions): TangentArc;
  (endPoint: Point2DLike, options?: TArcOptions): TangentArcToPoint;
}

function build(context: SceneParserContext): TArcFunction {
  return function tarc() {
    if (arguments.length > 0 && isPoint2DLike(arguments[0])) {
      const endPoint = normalizePoint2D(arguments[0] as Point2DLike);
      const options = arguments[1] as TArcOptions || {};
      const arc = new TangentArcToPoint(endPoint, options);
      context.addSceneObject(arc);
      return arc;
    }

    const radius = arguments[0] as number || 100;
    const endAngle = arguments[1] as number || 90;
    const options = arguments[2] as TArcOptions || {};

    const arc = new TangentArc(radius, endAngle, options);
    context.addSceneObject(arc);

    return arc;
  } as TArcFunction;
}

export default registerBuilder(build);
