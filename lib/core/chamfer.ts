import { Chamfer } from "../features/chamfer.js";
import { SceneObject } from "../common/scene-object.js";
import { registerBuilder, SceneParserContext } from "../index.js";

interface ChamferFunction {
  (distance?: number): Chamfer;
  (distance: number, selection: SceneObject): Chamfer;
  (distance: number, distance2: number, isAngle?: boolean): Chamfer;
  (distance: number, distance2: number, isAngle: boolean, selection: SceneObject): Chamfer;
}

function build(context: SceneParserContext): ChamferFunction {
  return function chamfer() {
    const args = Array.from(arguments);

    let selection: SceneObject | undefined;
    if (args.length > 0 && args[args.length - 1] instanceof SceneObject) {
      selection = args.pop() as SceneObject;
    } else {
      selection = context.getLastSelection() || undefined;
    }

    let distance = 1;
    let distance2: number = undefined;
    let isAngle = false;

    if (args.length >= 1 && typeof args[0] === 'number') {
      distance = args[0] as number;
    }

    if (args.length >= 2 && typeof args[1] === 'number') {
      distance2 = args[1] as number;
    }

    if (args.length >= 3 && typeof args[2] === 'boolean') {
      isAngle = args[2] as boolean;
    }

    const chamfer = new Chamfer(distance, distance2, isAngle, selection);

    context.addSceneObject(chamfer);
    return chamfer;
  };
}

export default registerBuilder(build);
