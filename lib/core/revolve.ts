import { normalizeAxis } from "../helpers/normalize.js";
import { registerBuilder, SceneParserContext } from "../index.js";
import { AxisLike } from "../math/axis.js";
import { Revolve } from "../features/revolve.js";
import { RevolveOptions } from "../features/revolve-options.js";
import { Sketch } from "../features/2d/sketch.js";
import { Extrudable } from "../helpers/types.js";
import { AxisObjectBase } from "../features/axis-renderable-base.js";
import { AxisObject } from "../features/axis.js";
import { resolveAxis } from "../helpers/resolve.js";

interface RevolveFunction {
  (axisLike: AxisLike, angle?: number): Revolve; // uses last extrudable, angle, not symmetric
  (axisLike: AxisLike, angle?: number, options?: RevolveOptions): Revolve; // uses last extrudable, angle, not symmetric
  (axisLike: AxisLike, options?: RevolveOptions): Revolve; // uses last extrudable, angle, not symmetric
  (extrudable: Sketch, axisLike: AxisLike, angle?: number, options?: RevolveOptions): Revolve; // extrudable, angle, symmetric
}

function build(context: SceneParserContext): RevolveFunction {

  function doRevolve(extrudable: Extrudable, params: any[]): Revolve {
    const defaultAngle = 360;
    const defaultOptions: RevolveOptions = {};

    // (axis)
    if (params.length === 1) {
      let axis = resolveAxis(params[0], context);
      return new Revolve(extrudable, axis, defaultAngle, defaultOptions);
    }

    // (axis, angle) or (axis, options)
    if (params.length === 2) {
      const axis = resolveAxis(params[0], context);
      if (typeof params[1] === 'number') {
        return new Revolve(extrudable, axis, params[1], defaultOptions);
      }
      if (typeof params[1] === 'object') {
        return new Revolve(extrudable, axis, defaultAngle, params[1]);
      }
    }

    // (axis, angle, options)
    if (params.length === 3) {
      const axis = resolveAxis(params[0], context);
      return new Revolve(extrudable, axis, params[1], params[2]);
    }

    throw new Error("Invalid parameters for revolve function.");
  }

  return function revolve(): Revolve {
    let result: Revolve;

    if (arguments[0] instanceof Sketch) {
      result = doRevolve(arguments[0], [...arguments].slice(1));
    } else {
      const lastExtrudable = context.getLastExtrudable();

      if (!lastExtrudable) {
        throw new Error("No extrudable object found in the scene.");
      }

      result = doRevolve(lastExtrudable, [...arguments]);
    }

    context.addSceneObject(result);
    return result;
  }
}

export default registerBuilder(build);
