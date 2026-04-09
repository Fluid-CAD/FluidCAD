import { registerBuilder, SceneParserContext } from "../index.js";
import { AxisLike } from "../math/axis.js";
import { Revolve } from "../features/revolve.js";
import { resolveAxis } from "../helpers/resolve.js";
import { Extrudable } from "../helpers/types.js";
import { SceneObject } from "../common/scene-object.js";
import { IRevolve, ISceneObject } from "./interfaces.js";

interface RevolveFunction {
  /**
   * Revolves the last sketch 360 degrees around an axis.
   * @param axisLike - The axis to revolve around
   * @param target - The sketch to revolve
   */
  (axisLike: AxisLike, target?: ISceneObject): IRevolve;
  /**
   * Revolves the last sketch by a given angle around an axis.
   * @param axisLike - The axis to revolve around
   * @param angle - The sweep angle in degrees
   * @param target - The sketch to revolve
   */
  (axisLike: AxisLike, angle: number, target?: ISceneObject): IRevolve;
}

function isExtrudable(obj: any): obj is Extrudable {
  return obj instanceof SceneObject && obj.isExtrudable();
}

function build(context: SceneParserContext): RevolveFunction {

  function doRevolve(params: any[], extrudable?: Extrudable): Revolve {
    const defaultAngle = 360;

    // (axis)
    if (params.length === 1) {
      const axis = resolveAxis(params[0], context);
      return new Revolve(axis, defaultAngle, extrudable);
    }

    // (axis, angle)
    if (params.length === 2) {
      const axis = resolveAxis(params[0], context);
      if (typeof params[1] === 'number') {
        return new Revolve(axis, params[1], extrudable);
      }
    }

    throw new Error("Invalid parameters for revolve function.");
  }

  return function revolve(): Revolve {
    const args = [...arguments];

    let extrudable: Extrudable | undefined;
    if (args.length > 0 && isExtrudable(args[args.length - 1])) {
      extrudable = args.pop() as Extrudable;
    } else {
      extrudable = context.getLastExtrudable() || undefined;
    }

    const result = doRevolve(args, extrudable);
    context.addSceneObject(result);
    return result;
  }
}

export default registerBuilder(build);
