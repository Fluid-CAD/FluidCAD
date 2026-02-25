import { TangentArc, TArcOptions } from "../../features/2d/tarc.js";
import { registerBuilder, SceneParserContext } from "../../index.js";

interface TArcFunction {
  (radius?: number, endAngle?: number, options?: TArcOptions): TangentArc;
}

function build(context: SceneParserContext): TArcFunction {
  return function tarc() {
    const radius = arguments[0] as number || 100;
    const endAngle = arguments[1] as number || 90;
    const options = arguments[2] as TArcOptions || {};

    const arc = new TangentArc(radius, endAngle, options);
    context.addSceneObject(arc);

    return arc;
  }
}

export default registerBuilder(build);
