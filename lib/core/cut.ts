import { SceneObject } from "../common/scene-object.js";
import { registerBuilder, SceneParserContext } from "../index.js";
import { Cut } from "../features/cut.js";
import { CutSymmetric } from "../features/cut-symmetric.js";
import { ExtrudeToFace } from "../features/extrude-to-face.js";
import { ExtrudeTwoDistances } from "../features/extrude-two-distances.js";
import { Sketch } from "../features/2d/sketch.js";
import { Extrudable } from "../helpers/types.js";

interface CutFunction {
  (extrudable: Sketch, distance?: number): Cut;
  (extrudable: Sketch, distance1: number, distance2: number): Cut;
  (extrudable: Sketch, face: SceneObject | 'first-face' | 'last-face'): Cut;
  (extrudable: Sketch, distance: number, symmetric?: true): Cut;
  (extrudable: Sketch, symmetric: true): Cut;

  (distance?: number): Cut;
  (distance1: number, distance2: number): Cut;
  (face: SceneObject | 'first-face' | 'last-face'): Cut;
  (distance: number, symmetric?: true): Cut;
  (symmetric: true): Cut;
}

function build(context: SceneParserContext): CutFunction {

  function doCut(extrudable: Extrudable, sceneObjects: SceneObject[], params: any[]): Cut | ExtrudeTwoDistances | ExtrudeToFace | CutSymmetric {
    console.log("Extrude called with params :", params);
    if (params.length === 0) {
      return new Cut(extrudable, 0);
    }
    else if (params.length === 1) {
      // overload 2
      // - extrude by one distance: number
      if (typeof params[0] === 'number') {
        return new Cut(extrudable, params[0]);
      }
      // - through all symmetric cut: true
      else if (params[0] === true) {
        return new CutSymmetric(extrudable, 0);
      }
      // - extrude to first face: 'first-face'
      else if (params[0] === 'first-face') {
        return new ExtrudeToFace(extrudable, 'first-face', sceneObjects);
      }
      // - extrude to last face: 'last-face'
      else if (params[0] === 'last-face') {
        return new ExtrudeToFace(extrudable, 'last-face', sceneObjects);
      }
      // - extrude to face: face
      else if (params[0] instanceof SceneObject) {
        return new ExtrudeToFace(extrudable, params[0] as SceneObject, sceneObjects);
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
      // - cut symmetric: number, boolean
      else if (typeof params[0] === 'number' && typeof params[1] === 'boolean') {
        return new CutSymmetric(extrudable, params[0]);
      }
    }

    throw new Error("Invalid parameters for extrude function.");
  }

  //@ts-ignore
  return function extrude() {
    let result: any;

    const sceneObjects = context.getSceneObjects();

    if (arguments[0] instanceof SceneObject && arguments[0].isExtrudable()) {
      // explicit mode
      result = doCut(arguments[0] as Extrudable, sceneObjects, [...arguments].slice(1));
    }
    else {
      const lastExtrudable = context.getLastExtrudable();

      if (!lastExtrudable) {
        throw new Error("No extrudable object found in the scene.");
      }

      // implicit mode
      result = doCut(lastExtrudable, sceneObjects, [...arguments]);
    }

    context.addSceneObject(result);
    return result;
  } as CutFunction;
}

export default registerBuilder(build)
