import { Chamfer } from "../features/chamfer.js";
import { registerBuilder, SceneParserContext } from "../index.js";
import { SceneObject } from "../common/scene-object.js";

interface ChamferFunction {
  (distance?: number): Chamfer;
  (distance: number, distance2: number, isAngle?: boolean): Chamfer;
  (selection: SceneObject, distance?: number): Chamfer;
  (selection: SceneObject, distance: number, distance2: number, isAngle?: boolean): Chamfer;
}

function build(context: SceneParserContext): ChamferFunction {
  return function chamfer() {
    if (arguments.length === 0) {
      const selection = context.getLastSelection();
      const chamfer = new Chamfer(selection, 1, undefined);
      context.addSceneObject(chamfer);
      return chamfer;
    }

    if (arguments.length === 1) {
      if (typeof arguments[0] === 'number') {
        const distance = arguments[0] as number;
        const selection = context.getLastSelection();
        const chamfer = new Chamfer(selection, distance, undefined);
        context.addSceneObject(chamfer);
        return chamfer;
      }

      if (arguments[0] instanceof SceneObject) {
        const selection = arguments[0] as SceneObject;
        const chamfer = new Chamfer(selection, 1, undefined);
        context.addSceneObject(chamfer);
        return chamfer;
      }
    }

    if (arguments.length === 2) {
      if (typeof arguments[0] === 'number' && typeof arguments[1] === 'number') {
        const distance = arguments[0] as number;
        const distance2 = arguments[1] as number;
        const selection = context.getLastSelection();
        const chamfer = new Chamfer(selection, distance, distance2);
        context.addSceneObject(chamfer);
        return chamfer;
      }

      if (arguments[0] instanceof SceneObject && typeof arguments[1] === 'number') {
        const selection = arguments[0] as SceneObject;
        const distance = arguments[1] as number;
        const chamfer = new Chamfer(selection, distance, undefined);
        context.addSceneObject(chamfer);
        return chamfer;
      }
    }

    if (arguments.length === 3) {
      if (typeof arguments[0] === 'number' && typeof arguments[1] === 'number' && typeof arguments[2] === 'boolean') {
        const distance = arguments[0] as number;
        const distance2 = arguments[1] as number;
        const isAngle = arguments[2] as boolean;
        const selection = context.getLastSelection();
        const chamfer = new Chamfer(selection, distance, distance2, isAngle);
        context.addSceneObject(chamfer);
        return chamfer;
      }

      if (arguments[0] instanceof SceneObject && typeof arguments[1] === 'number' && typeof arguments[2] === 'number') {
        const selection = arguments[0] as SceneObject;
        const distance = arguments[1] as number;
        const distance2 = arguments[2] as number;
        const chamfer = new Chamfer(selection, distance, distance2);
        context.addSceneObject(chamfer);
        return chamfer;
      }
    }

    if (arguments.length === 4 && arguments[0] instanceof SceneObject) {
      const selection = arguments[0] as SceneObject;
      const distance = arguments[1] as number;
      const distance2 = arguments[2] as number;
      const isAngle = arguments[3] as boolean;
      const chamfer = new Chamfer(selection, distance, distance2, isAngle);
      context.addSceneObject(chamfer);
      return chamfer;
    }
  };
}

export default registerBuilder(build);
