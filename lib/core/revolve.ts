import { registerBuilder, SceneParserContext } from "../index.js";
import { AxisLike } from "../math/axis.js";
import { Revolve } from "../features/revolve.js";
import { RevolveOptions } from "../features/revolve-options.js";
import { resolveAxis } from "../helpers/resolve.js";

interface RevolveFunction {
  (axisLike: AxisLike, angle?: number): Revolve;
  (axisLike: AxisLike, angle?: number, options?: RevolveOptions): Revolve;
  (axisLike: AxisLike, options?: RevolveOptions): Revolve;
}

function build(context: SceneParserContext): RevolveFunction {

  function doRevolve(params: any[]): Revolve {
    const defaultAngle = 360;
    const defaultOptions: RevolveOptions = {};

    // (axis)
    if (params.length === 1) {
      const axis = resolveAxis(params[0], context);
      return new Revolve(axis, defaultAngle, defaultOptions);
    }

    // (axis, angle) or (axis, options)
    if (params.length === 2) {
      const axis = resolveAxis(params[0], context);
      if (typeof params[1] === 'number') {
        return new Revolve(axis, params[1], defaultOptions);
      }
      if (typeof params[1] === 'object') {
        return new Revolve(axis, defaultAngle, params[1]);
      }
    }

    // (axis, angle, options)
    if (params.length === 3) {
      const axis = resolveAxis(params[0], context);
      return new Revolve(axis, params[1], params[2]);
    }

    throw new Error("Invalid parameters for revolve function.");
  }

  return function revolve(): Revolve {
    const result = doRevolve([...arguments]);

    const lastExtrudable = context.getLastExtrudable();
    if (lastExtrudable) {
      result.target(lastExtrudable);
    }

    context.addSceneObject(result);
    return result;
  }
}

export default registerBuilder(build);
