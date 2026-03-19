import { Chamfer } from "../features/chamfer.js";
import { registerBuilder, SceneParserContext } from "../index.js";

interface ChamferFunction {
  (distance?: number): Chamfer;
  (distance: number, distance2: number, isAngle?: boolean): Chamfer;
}

function build(context: SceneParserContext): ChamferFunction {
  return function chamfer() {
    let distance = 1;
    let distance2: number = undefined;
    let isAngle = false;

    if (arguments.length >= 1 && typeof arguments[0] === 'number') {
      distance = arguments[0] as number;
    }

    if (arguments.length >= 2 && typeof arguments[1] === 'number') {
      distance2 = arguments[1] as number;
    }

    if (arguments.length >= 3 && typeof arguments[2] === 'boolean') {
      isAngle = arguments[2] as boolean;
    }

    const chamfer = new Chamfer(distance, distance2, isAngle);

    const selection = context.getLastSelection();
    if (selection) {
      chamfer.target(selection);
    }

    context.addSceneObject(chamfer);
    return chamfer;
  };
}

export default registerBuilder(build);
