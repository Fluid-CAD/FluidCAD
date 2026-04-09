import { SceneObject } from "../common/scene-object.js";
import { registerBuilder, SceneParserContext } from "../index.js";
import { Extrude } from "../features/extrude.js";
import { ExtrudeTwoDistances } from "../features/extrude-two-distances.js";
import { ExtrudeToFace } from "../features/extrude-to-face.js";
import { SelectSceneObject } from "../features/select.js";
import { ExtrudeBase } from "../features/extrude-base.js";
import { Extrudable } from "../helpers/types.js";
import { IExtrude, ISceneObject } from "./interfaces.js";

interface ExtrudeFunction {
  /**
   * Extrudes the last sketch with a default distance.
   * @param target - The sketch to extrude
   */
  (target?: ISceneObject): IExtrude;
  /**
   * Extrudes the last sketch by a given distance.
   * @param distance - The extrusion distance
   * @param target - The sketch to extrude
   */
  (distance: number, target?: ISceneObject): IExtrude;
  /**
   * Extrudes the last sketch between two distances.
   * @param distance1 - The first extrusion distance
   * @param distance2 - The second extrusion distance
   * @param target - The sketch to extrude
   */
  (distance1: number, distance2: number): IExtrude;
  /**
   * Extrudes the given sketch between two distances.
   * @param distance1 - The first extrusion distance
   * @param distance2 - The second extrusion distance
   * @param target - The sketch to extrude
   */
  (distance1: number, distance2: number, target: ISceneObject): IExtrude;
  /**
   * Extrudes the last sketch up to a face.
   * @param face - The face to extrude up to, or `'first-face'`/`'last-face'`
   * @param target - The sketch to extrude
   */
  (face: ISceneObject | 'first-face' | 'last-face', target?: ISceneObject): IExtrude;
}

function isExtrudable(obj: any): obj is Extrudable {
  return obj instanceof SceneObject && obj.isExtrudable();
}

function build(context: SceneParserContext): ExtrudeFunction {

  function doExtrude(params: any[], extrudable?: Extrudable): ExtrudeBase {
    const defaultDistance = 25;

    if (params.length === 0) {
      return new Extrude(defaultDistance, extrudable);
    }
    if (params.length === 1) {
      if (typeof params[0] === 'number') {
        return new Extrude(params[0], extrudable);
      }
      else if (params[0] === 'first-face') {
        return new ExtrudeToFace('first-face', extrudable);
      }
      else if (params[0] === 'last-face') {
        return new ExtrudeToFace('last-face', extrudable);
      }
      else if (params[0] instanceof SceneObject) {
        context.addSceneObject(params[0] as SceneObject);
        return new ExtrudeToFace(params[0] as SelectSceneObject, extrudable);
      }
      else {
        throw new Error("Invalid parameter for extrude function.");
      }
    }
    else if (params.length === 2) {
      if (typeof params[0] === 'number' && typeof params[1] === 'number') {
        return new ExtrudeTwoDistances(params[0], params[1], extrudable);
      }
    }

    throw new Error("Invalid parameters for extrude function.");
  }

  //@ts-ignore
  return function extrude() {
    const args = [...arguments];

    let extrudable: Extrudable | undefined;
    if (args.length > 0 && isExtrudable(args[args.length - 1])) {
      extrudable = args.pop() as Extrudable;
    } else {
      extrudable = context.getLastExtrudable() || undefined;
    }

    const result = doExtrude(args, extrudable);
    context.addSceneObject(result);
    return result;
  } as ExtrudeFunction;
}

export default registerBuilder(build)
