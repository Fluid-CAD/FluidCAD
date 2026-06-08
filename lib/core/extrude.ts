import { SceneObject } from "../common/scene-object.js";
import { registerBuilder, SceneParserContext } from "../index.js";
import { Extrude } from "../features/extrude.js";
import { ExtrudeTwoDistances } from "../features/extrude-two-distances.js";
import { ExtrudeToFace } from "../features/extrude-to-face.js";
import { SelectSceneObject } from "../features/select.js";
import { ExtrudeBase } from "../features/extrude-base.js";
import { Extrudable } from "../helpers/types.js";
import { IExtrude, ISceneObject } from "./interfaces.js";
import { FaceFilterBuilder } from "../filters/face/face-filter.js";
import { type NumberParam, isNumberParam, resolveParam } from "./param.js";

interface ExtrudeFunction {
  /**
   * Extrudes the last sketch with a default distance.
   * @param target - The sketch or face-bearing scene object to extrude
   */
  (target?: ISceneObject): IExtrude;
  /**
   * Extrudes by a given distance.
   * @param distance - The extrusion distance
   * @param target - The sketch or face-bearing scene object to extrude
   */
  (distance: NumberParam, target?: ISceneObject): IExtrude;
  /**
   * Extrudes between two distances.
   * @param distance1 - The first extrusion distance
   * @param distance2 - The second extrusion distance
   */
  (distance1: NumberParam, distance2: NumberParam): IExtrude;
  /**
   * Extrudes between two distances.
   * @param distance1 - The first extrusion distance
   * @param distance2 - The second extrusion distance
   * @param target - The sketch or face-bearing scene object to extrude
   */
  (distance1: NumberParam, distance2: NumberParam, target: ISceneObject): IExtrude;
  /**
   * Extrudes up to a specific face.
   * @param face - A face selection to extrude up to
   * @param target - The sketch or face-bearing scene object to extrude
   */
  (face: ISceneObject, target?: ISceneObject): IExtrude;
  /**
   * Extrudes up to the first intersecting face.
   * @param face - The literal `'first-face'`
   * @param filters - Optional face filters to narrow the candidate set
   */
  (face: 'first-face', ...filters: FaceFilterBuilder[]): IExtrude;
  /**
   * Extrudes up to the first intersecting face.
   * @param face - The literal `'first-face'`
   * @param filtersAndTarget - Optional face filters followed by the target to extrude
   */
  (face: 'first-face', ...filtersAndTarget: [...FaceFilterBuilder[], ISceneObject]): IExtrude;
  /**
   * Extrudes up to the last intersecting face.
   * @param face - The literal `'last-face'`
   * @param filters - Optional face filters to narrow the candidate set
   */
  (face: 'last-face', ...filters: FaceFilterBuilder[]): IExtrude;
  /**
   * Extrudes up to the last intersecting face.
   * @param face - The literal `'last-face'`
   * @param filtersAndTarget - Optional face filters followed by the target to extrude
   */
  (face: 'last-face', ...filtersAndTarget: [...FaceFilterBuilder[], ISceneObject]): IExtrude;
}

function isExtrudable(obj: any): obj is Extrudable {
  return obj instanceof SceneObject && obj.isExtrudable();
}

function isFaceSource(obj: any): boolean {
  if (!(obj instanceof SceneObject)) {
    return false;
  }
  if (isExtrudable(obj)) {
    return false;
  }
  if (obj instanceof SelectSceneObject) {
    return obj.shapeType() === 'face';
  }
  return true;
}

function build(context: SceneParserContext): ExtrudeFunction {

  function doExtrude(params: any[], extrudable?: Extrudable | SceneObject): ExtrudeBase {
    const defaultDistance = 25;

    if (params.length === 0) {
      return new Extrude(defaultDistance, extrudable);
    }

    if (params[0] === 'first-face' || params[0] === 'last-face') {
      const rest = params.slice(1);
      if (!rest.every(a => a instanceof FaceFilterBuilder)) {
        throw new Error("Invalid parameter for extrude function.");
      }
      return new ExtrudeToFace(params[0], extrudable, rest as FaceFilterBuilder[]);
    }

    if (params.length === 1) {
      if (isNumberParam(params[0])) {
        return new Extrude(resolveParam(params[0] as NumberParam), extrudable);
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
      if (isNumberParam(params[0]) && isNumberParam(params[1])) {
        return new ExtrudeTwoDistances(resolveParam(params[0] as NumberParam), resolveParam(params[1] as NumberParam), extrudable);
      }
    }

    throw new Error("Invalid parameters for extrude function.");
  }

  //@ts-ignore
  return function extrude() {
    const args = [...arguments];

    let extrudable: Extrudable | SceneObject | undefined;
    const last = args.length > 0 ? args[args.length - 1] : undefined;
    if (last !== undefined && isExtrudable(last)) {
      extrudable = args.pop() as Extrudable;
    } else if (last !== undefined && args.length >= 2 && isFaceSource(last)) {
      extrudable = args.pop() as SceneObject;
      context.addSceneObject(extrudable);
    } else {
      extrudable = context.getLastExtrudable() || undefined;
    }

    const result = doExtrude(args, extrudable);
    context.addSceneObject(result);
    return result;
  } as ExtrudeFunction;
}

export default registerBuilder(build)
