import { SceneObject } from "../common/scene-object.js";
import { registerBuilder, SceneParserContext } from "../index.js";
import { Extrude } from "../features/extrude.js";
import { ExtrudeTwoDistances } from "../features/extrude-two-distances.js";
import { ExtrudeToFace } from "../features/extrude-to-face.js";
import { ExtrudeSymmetric } from "../features/extrude-symmetric.js";
import { SelectSceneObject } from "../features/select.js";
import { Extrudable } from "../helpers/types.js";

interface ExtrudeFunction {
  (extrudable: Extrudable, distance?: number): Extrude;
  (extrudable: Extrudable, distance1: number, distance2: number): ExtrudeTwoDistances;
  (extrudable: Extrudable, distance: number, symmetric?: true): ExtrudeSymmetric;
  (extrudable: Extrudable, face: SceneObject | 'first-face' | 'last-face'): ExtrudeToFace;

  (distance?: number): Extrude;
  (distance1: number, distance2: number): ExtrudeTwoDistances;
  (distance: number, symmetric: true): ExtrudeSymmetric;
  (face: SceneObject | 'first-face' | 'last-face'): ExtrudeToFace;
}

function build(context: SceneParserContext): ExtrudeFunction {

  function doExtrude(extrudable: Extrudable, params: any[]): Extrude | ExtrudeTwoDistances | ExtrudeToFace | ExtrudeSymmetric {
    const defaultDistance = 25;

    if (params.length === 0) {
      return new Extrude(extrudable, defaultDistance);
    }
    if (params.length === 1) {
      // overload 2
      // - extrude by one distance: number
      if (typeof params[0] === 'number') {
        return new Extrude(extrudable, params[0]);
      }
      // - extrude to first face: 'first-face'
      else if (params[0] === 'first-face') {
        return new ExtrudeToFace(extrudable, 'first-face');
      }
      // - extrude to last face: 'last-face'
      else if (params[0] === 'last-face') {
        return new ExtrudeToFace(extrudable, 'last-face');
      }
      // - extrude to face: face
      else if (params[0] instanceof SceneObject) {
        return new ExtrudeToFace(extrudable, params[0] as SelectSceneObject);
      }
      else {
        throw new Error("Invalid parameter for extrude function.");
      }
    }
    else if (params.length === 2) {
      // overload 3
      // - extrude by two distances: number, number
      if (typeof params[0] === 'number' && typeof params[1] === 'number') {
        return new ExtrudeTwoDistances(extrudable, params[0], params[1]);
      }
      // - extrude symmetric: number, boolean
      else if (typeof params[0] === 'number' && typeof params[1] === 'boolean') {
        return new ExtrudeSymmetric(extrudable, params[0]);
      }
    }

    throw new Error("Invalid parameters for extrude function.");
  }

  //@ts-ignore
  return function extrude() {
    let result: any;

    if (arguments[0] instanceof SceneObject && arguments[0].isExtrudable()) {
      // explicit mode
      result = doExtrude(arguments[0] as Extrudable, [...arguments].slice(1));
    }
    else {
      const lastExtrudable = context.getLastExtrudable();

      if (!lastExtrudable) {
        throw new Error("No extrudable object found in the scene.");
      }

      // implicit mode
      result = doExtrude(lastExtrudable, [...arguments]);
    }

    context.addSceneObject(result);
    return result;
  } as ExtrudeFunction;
}

export default registerBuilder(build)
