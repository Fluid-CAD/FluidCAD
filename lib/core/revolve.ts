import { registerBuilder, SceneParserContext } from "../index.js";
import { AxisLike } from "../math/axis.js";
import { Revolve } from "../features/revolve.js";
import { RevolveOptions } from "../features/revolve-options.js";
import { resolveAxis } from "../helpers/resolve.js";
import { Extrudable } from "../helpers/types.js";
import { SceneObject } from "../common/scene-object.js";
import { ISceneObject } from "./interfaces.js";

interface RevolveFunction {
  (axisLike: AxisLike, target?: ISceneObject): ISceneObject;
  (axisLike: AxisLike, angle: number, target?: ISceneObject): ISceneObject;
  (axisLike: AxisLike, angle: number, options: RevolveOptions, target?: ISceneObject): ISceneObject;
  (axisLike: AxisLike, options: RevolveOptions, target?: ISceneObject): ISceneObject;
}

function isExtrudable(obj: any): obj is Extrudable {
  return obj instanceof SceneObject && 'getGeometries' in obj && 'getPlane' in obj;
}

function build(context: SceneParserContext): RevolveFunction {

  function doRevolve(params: any[], extrudable?: Extrudable): Revolve {
    const defaultAngle = 360;
    const defaultOptions: RevolveOptions = {};

    // (axis)
    if (params.length === 1) {
      const axis = resolveAxis(params[0], context);
      return new Revolve(axis, defaultAngle, defaultOptions, extrudable);
    }

    // (axis, angle) or (axis, options)
    if (params.length === 2) {
      const axis = resolveAxis(params[0], context);
      if (typeof params[1] === 'number') {
        return new Revolve(axis, params[1], defaultOptions, extrudable);
      }
      if (typeof params[1] === 'object') {
        return new Revolve(axis, defaultAngle, params[1], extrudable);
      }
    }

    // (axis, angle, options)
    if (params.length === 3) {
      const axis = resolveAxis(params[0], context);
      return new Revolve(axis, params[1], params[2], extrudable);
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
