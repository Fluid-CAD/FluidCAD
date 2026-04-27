import { registerBuilder, SceneParserContext } from "../index.js";
import { normalizeAxis } from "../helpers/normalize.js";
import { Rotate } from "../features/rotate.js";
import { AxisLike } from "../math/axis.js";
import { SceneObject } from "../common/scene-object.js";
import { AxisObjectBase } from "../features/axis-renderable-base.js";
import { AxisObject } from "../features/axis.js";
import { Rotate2D } from "../features/rotate2d.js";
import { IRotate, ISceneObject } from "./interfaces.js";

interface RotateFunction {
  /**
   * [2D] Rotates geometry by an angle inside a sketch.
   * @param angle - The rotation angle in degrees
   * @param targets - The geometries to rotate (defaults to last object)
   */
  (angle: number, ...targets: ISceneObject[]): IRotate;
  /**
   * [2D] Rotates geometry by an angle inside a sketch, optionally making a copy.
   * @param angle - The rotation angle in degrees
   * @param copy - Whether to copy instead of move
   * @param targets - The geometries to rotate (defaults to last object)
   */
  (angle: number, copy: boolean, ...targets: ISceneObject[]): IRotate;

  /**
   * [3D] Rotates objects around an axis by an angle.
   * @param axis - The axis to rotate around
   * @param angle - The rotation angle in degrees
   * @param targets - The objects to rotate (defaults to last object)
   */
  (axis: AxisLike, angle: number, ...targets: ISceneObject[]): IRotate;
  /**
   * [3D] Rotates objects around an axis by an angle, optionally making a copy.
   * @param axis - The axis to rotate around
   * @param angle - The rotation angle in degrees
   * @param copy - Whether to copy instead of move
   * @param targets - The objects to rotate (defaults to last object)
   */
  (axis: AxisLike, angle: number, copy: boolean, ...targets: ISceneObject[]): IRotate;
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
    if (args.length === 1) {
      if (!activeSketch) {
        throw new Error("rotate(angle) is only valid inside a sketch. For 3D rotation, specify an axis: rotate(axis, angle).");
      }
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

