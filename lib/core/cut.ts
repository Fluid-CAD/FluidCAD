import { SceneObject } from "../common/scene-object.js";
import { registerBuilder, SceneParserContext } from "../index.js";
import { Cut } from "../features/cut.js";
import { CutSymmetric } from "../features/cut-symmetric.js";
import { ExtrudeToFace } from "../features/extrude-to-face.js";
import { ExtrudeTwoDistances } from "../features/extrude-two-distances.js";
import { CutBase } from "../features/cut-base.js";
import { ExtrudeBase } from "../features/extrude-base.js";
import { Extrudable } from "../helpers/types.js";
import { ICut, ISceneObject } from "./interfaces.js";

interface CutFunction {
  (target?: ISceneObject): ICut;
  (distance: number, target?: ISceneObject): ICut;
  (distance1: number, distance2: number, target?: ISceneObject): ICut;
  (face: ISceneObject | 'first-face' | 'last-face', target?: ISceneObject): ICut;
  (distance: number, symmetric: true, target?: ISceneObject): ICut;
  (symmetric: true, target?: ISceneObject): ICut;
}

function isExtrudable(obj: any): obj is Extrudable {
  return obj instanceof SceneObject && 'getGeometries' in obj && 'getPlane' in obj;
}

function build(context: SceneParserContext): CutFunction {

  function doCut(params: any[], extrudable?: Extrudable): CutBase | ExtrudeBase {
    console.log("Extrude called with params :", params);
    if (params.length === 0) {
      return new Cut(0, extrudable);
    }
    else if (params.length === 1) {
      if (typeof params[0] === 'number') {
        return new Cut(params[0], extrudable);
      }
      else if (params[0] === true) {
        return new CutSymmetric(0, extrudable);
      }
      else if (params[0] === 'first-face') {
        return new ExtrudeToFace('first-face', extrudable);
      }
      else if (params[0] === 'last-face') {
        return new ExtrudeToFace('last-face', extrudable);
      }
      else if (params[0] instanceof SceneObject) {
        return new ExtrudeToFace(params[0] as SceneObject, extrudable);
      }
      else {
        throw new Error("Invalid parameter for extrude function.");
      }
    }
    else if (params.length === 2) {
      if (typeof params[0] === 'number' && typeof params[1] === 'number') {
        return new ExtrudeTwoDistances(params[0], params[1], extrudable);
      }
      else if (typeof params[0] === 'number' && typeof params[1] === 'boolean') {
        return new CutSymmetric(params[0], extrudable);
      }
    }

    throw new Error("Invalid parameters for extrude function.");
  }

  //@ts-ignore
  return function cut() {
    const args = [...arguments];

    let extrudable: Extrudable | undefined;
    if (args.length > 0 && isExtrudable(args[args.length - 1])) {
      extrudable = args.pop() as Extrudable;
    } else {
      extrudable = context.getLastExtrudable() || undefined;
    }

    const result = doCut(args, extrudable);
    context.addSceneObject(result);
    return result;
  } as CutFunction;
}

export default registerBuilder(build)
