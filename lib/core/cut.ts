import { SceneObject } from "../common/scene-object.js";
import { registerBuilder, SceneParserContext } from "../index.js";
import { Extrude } from "../features/extrude.js";
import { ExtrudeToFace } from "../features/extrude-to-face.js";
import { ExtrudeTwoDistances } from "../features/extrude-two-distances.js";
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
}

function isExtrudable(obj: any): obj is Extrudable {
  return obj instanceof SceneObject && 'getGeometries' in obj && 'getPlane' in obj;
}

function build(context: SceneParserContext): CutFunction {

  function doCut(params: any[], extrudable?: Extrudable): ExtrudeBase {
    if (params.length === 0) {
      return new Extrude(0, extrudable).remove();
    }
    else if (params.length === 1) {
      if (typeof params[0] === 'number') {
        return new Extrude(params[0], extrudable).remove();
      }
      else if (params[0] === 'first-face') {
        return new ExtrudeToFace('first-face', extrudable).remove();
      }
      else if (params[0] === 'last-face') {
        return new ExtrudeToFace('last-face', extrudable).remove();
      }
      else if (params[0] instanceof SceneObject) {
        context.addSceneObject(params[0] as SceneObject);
        return new ExtrudeToFace(params[0] as SceneObject, extrudable).remove();
      }
      else {
        throw new Error("Invalid parameter for cut function.");
      }
    }
    else if (params.length === 2) {
      if (typeof params[0] === 'number' && typeof params[1] === 'number') {
        return new ExtrudeTwoDistances(params[0], params[1], extrudable).remove();
      }
    }

    throw new Error("Invalid parameters for cut function.");
  }

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
