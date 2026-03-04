import { SceneObject } from "../common/scene-object.js";
import { registerBuilder, SceneParserContext } from "../index.js";
import { Cut, CutOptions } from "../features/cut.js";
import { CutSymmetric } from "../features/cut-symmetric.js";
import { ExtrudeToFace } from "../features/extrude-to-face.js";
import { ExtrudeTwoDistances } from "../features/extrude-two-distances.js";
import { ExtrudeOptions } from "../features/extrude-options.js";
import { Sketch } from "../features/2d/sketch.js";
import { Extrudable } from "../helpers/types.js";

interface CutFunction {
  (extrudable: Sketch, distance?: number): Cut;
  (extrudable: Sketch, distance: number, options: CutOptions): Cut;
  (extrudable: Sketch, distance1: number, distance2: number): Cut;
  (extrudable: Sketch, distance1: number, distance2: number, options: CutOptions): Cut;
  (extrudable: Sketch, face: SceneObject | 'first-face' | 'last-face'): Cut;
  (extrudable: Sketch, face: SceneObject | 'first-face' | 'last-face', options: CutOptions): Cut;
  (extrudable: Sketch, distance: number, symmetric?: true): Cut;
  (extrudable: Sketch, distance: number, symmetric?: boolean, options?: CutOptions): Cut;

  (distance?: number): Cut;
  (distance: number, options: CutOptions): Cut;
  (distance1: number, distance2: number): Cut;
  (distance1: number, distance2: number, options: CutOptions): Cut;
  (face: SceneObject | 'first-face' | 'last-face'): Cut;
  (face: SceneObject | 'first-face' | 'last-face', options: CutOptions): Cut;
  (distance: number, symmetric?: true): Cut;
  (distance: number, symmetric?: boolean, options?: CutOptions): Cut;
}

function build(context: SceneParserContext): CutFunction {

  function doCut(extrudable: Extrudable, sceneObjects: SceneObject[], params: any[]): Cut | ExtrudeTwoDistances | ExtrudeToFace | CutSymmetric {
    const defaultOptions: CutOptions = {
    }

    console.log("Extrude called with params :", params);
    if (params.length === 0) {
      return new Cut(extrudable, 0, defaultOptions);
    }
    else if (params.length === 1) {
      // overload 2
      // - extrude by one distance: number
      if (typeof params[0] === 'number') {
        return new Cut(extrudable, params[0], defaultOptions);
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
      // - extrude by one distance + options: number, {}
      else if (typeof params[0] === 'number' && typeof params[1] === 'object') {
        const options: CutOptions = params[1];
        return new Cut(extrudable, params[0], options);
      }
      // - cut symmetric: number, boolean
      else if (typeof params[0] === 'number' && typeof params[1] === 'boolean') {
        return new CutSymmetric(extrudable, params[0]);
      }
      // - extrude to first face + options: 'first-face', {}
      else if (params[0] === 'first-face' && typeof params[1] === 'object') {
        return new ExtrudeToFace(extrudable, 'first-face', sceneObjects, params[1]);
      }
      // - extrude to last-face + options: 'last-face', {}
      else if (params[0] === 'last-face' && typeof params[1] === 'object') {
        return new ExtrudeToFace(extrudable, 'last-face', sceneObjects, params[1]);
      }
      // - extrude to face + options: face, {}
      else if (params[0] instanceof SceneObject && typeof (params[1]) === 'object') {
        const options: ExtrudeOptions = params[1];
        return new ExtrudeToFace(extrudable, params[0] as SceneObject, sceneObjects, options);
      }
    }
    else if (params.length === 3) {
      // overload 3
      // - extrude two distances + options: number, number, {}
      if (typeof params[0] === 'number' && typeof params[1] === 'number' && typeof params[2] === 'object') {
        const options: ExtrudeOptions = params[2];
        return new ExtrudeTwoDistances(extrudable, params[0], params[1], options);
      }
      // - cut symmetric + options: number, boolean, {}
      else if (typeof params[0] === 'number' && typeof params[1] === 'boolean' && typeof params[2] === 'object') {
        const options: CutOptions = params[2];
        return new CutSymmetric(extrudable, params[0], options);
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
