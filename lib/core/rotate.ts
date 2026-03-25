import { registerBuilder, SceneParserContext } from "../index.js";
import { normalizeAxis } from "../helpers/normalize.js";
import { Rotate } from "../features/rotate.js";
import { AxisLike } from "../math/axis.js";
import { SceneObject } from "../common/scene-object.js";
import { AxisObjectBase } from "../features/axis-renderable-base.js";
import { AxisObject } from "../features/axis.js";
import { Rotate2D } from "../features/rotate2d.js";
import { ISceneObject } from "./interfaces.js";

interface RotateFunction {
  // 2D rotation inside a sketch
  (angle: number, ...targets: ISceneObject[]): ISceneObject;
  (angle: number, copy: boolean, ...targets: ISceneObject[]): ISceneObject;

  // 3D rotation
  (axis: AxisLike, angle: number, ...targets: ISceneObject[]): ISceneObject;
  (axis: AxisLike, angle: number, copy: boolean, ...targets: ISceneObject[]): ISceneObject;
}

function build(context: SceneParserContext): RotateFunction {
  return function rotate() {
    const args = Array.from(arguments);
    const activeSketch = context.getActiveSketch();

    // Extract SceneObject targets from the end
    const targets: SceneObject[] = [];
    while (args.length > 0 && args[args.length - 1] instanceof SceneObject) {
      targets.unshift(args.pop() as SceneObject);
    }

    // Extract copy flag from the end (if boolean)
    const copy = typeof args[args.length - 1] === 'boolean' ? args.pop() as boolean : false;

    // 2D: rotate(angle, copy?, ...targets)
    if (args.length === 1 && activeSketch) {
      const angle = args[0] as number;
      const rotate = new Rotate2D(angle, copy, ...targets);
      context.addSceneObject(rotate);
      return rotate;
    }

    if (activeSketch && args.length !== 2) {
      throw new Error("Cannot specify an axis for rotate inside a sketch. Use rotate(angle) instead.");
    }

    // 3D: rotate(axis, angle, copy?, ...targets)
    if (args.length === 2) {
      let axis: AxisObjectBase = null;
      if (args[0] instanceof AxisObjectBase) {
        axis = args[0] as AxisObjectBase;
      } else {
        const a = normalizeAxis(args[0]);
        axis = new AxisObject(a);
        context.addSceneObject(axis);
      }

      const angle = args[1] as number;
      const rotate = new Rotate(axis, angle, copy, ...targets);
      context.addSceneObject(rotate);
      return rotate;
    }

    throw new Error("Invalid arguments for rotate function");
  } as RotateFunction;
}

export default registerBuilder(build);

