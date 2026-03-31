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
  /**
   * Cuts through all using the last sketch
   * @param target - The sketch to cut with
   */
  (): ICut;
  /**
   * Cuts using the given sketch with a default distance.
   * @param target - The sketch to cut with
   */
  (target: ISceneObject): ICut;
  /**
   * Cuts using the given sketch by a given distance.
   * @param distance - The cut depth
   * @param target - The sketch to cut with
   */
  (distance: number, target?: ISceneObject): ICut;
  /**
   * Cuts by two distances using the last sketch.
   * @param distance1 - The first cut distance
   * @param distance2 - The second cut distance
   */
  (distance1: number, distance2: number): ICut;
  /**
   * Cuts by two distances using the given sketch.
   * @param distance1 - The first cut distance
   * @param distance2 - The second cut distance
   * @param target - The sketch to cut with
   */
  (distance1: number, distance2: number, target: ISceneObject): ICut;
  /**
   * Cuts up to face using the last sketch.
   * @param face - The face to cut up to, or `'first-face'`/`'last-face'`
   * @param target - The sketch to cut with
   */
  (face: ISceneObject | 'first-face' | 'last-face'): ICut;
  /**
   * Cuts up to face using the given sketch.
   * @param face - The face to cut up to, or `'first-face'`/`'last-face'`
   * @param target - The sketch to cut with
   */
  (face: ISceneObject | 'first-face' | 'last-face', target: ISceneObject): ICut;
  /**
   * Cuts symmetrically in both directions using the last sketch.
   * @param distance - The cut depth in each direction
   * @param symmetric - Must be `true`
   * @param target - The sketch to cut with
   */
  (distance: number, symmetric: true): ICut;
  /**
   * Cuts symmetrically in both directions using the given sketch.
   * @param distance - The cut depth in each direction
   * @param symmetric - Must be `true`
   * @param target - The sketch to cut with
   */
  (distance: number, symmetric: true, target: ISceneObject): ICut;
  /**
   * Cuts through the last sketch symmetrically with a default distance.
   * @param symmetric - Must be `true`
   * @param target - The sketch to cut with
   */
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
