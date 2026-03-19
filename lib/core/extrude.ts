import { SceneObject } from "../common/scene-object.js";
import { registerBuilder, SceneParserContext } from "../index.js";
import { Extrude } from "../features/extrude.js";
import { ExtrudeTwoDistances } from "../features/extrude-two-distances.js";
import { ExtrudeToFace } from "../features/extrude-to-face.js";
import { ExtrudeSymmetric } from "../features/extrude-symmetric.js";
import { SelectSceneObject } from "../features/select.js";
import { ExtrudeBase } from "../features/extrude-base.js";

interface ExtrudeFunction {
  (distance?: number): Extrude;
  (distance1: number, distance2: number): ExtrudeTwoDistances;
  (distance: number, symmetric: true): ExtrudeSymmetric;
  (face: SceneObject | 'first-face' | 'last-face'): ExtrudeToFace;
}

function build(context: SceneParserContext): ExtrudeFunction {

  function doExtrude(params: any[]): ExtrudeBase {
    const defaultDistance = 25;

    if (params.length === 0) {
      return new Extrude(defaultDistance);
    }
    if (params.length === 1) {
      if (typeof params[0] === 'number') {
        return new Extrude(params[0]);
      }
      else if (params[0] === 'first-face') {
        return new ExtrudeToFace('first-face');
      }
      else if (params[0] === 'last-face') {
        return new ExtrudeToFace('last-face');
      }
      else if (params[0] instanceof SceneObject) {
        return new ExtrudeToFace(params[0] as SelectSceneObject);
      }
      else {
        throw new Error("Invalid parameter for extrude function.");
      }
    }
    else if (params.length === 2) {
      if (typeof params[0] === 'number' && typeof params[1] === 'number') {
        return new ExtrudeTwoDistances(params[0], params[1]);
      }
      else if (typeof params[0] === 'number' && typeof params[1] === 'boolean') {
        return new ExtrudeSymmetric(params[0]);
      }
    }

    throw new Error("Invalid parameters for extrude function.");
  }

  //@ts-ignore
  return function extrude() {
    const result = doExtrude([...arguments]);

    const lastExtrudable = context.getLastExtrudable();
    if (lastExtrudable) {
      result.target(lastExtrudable);
    }

    context.addSceneObject(result);
    return result;
  } as ExtrudeFunction;
}

export default registerBuilder(build)
