import { registerBuilder, SceneParserContext } from "../index.js";
import { normalizeAxis } from "../helpers/normalize.js";
import { Rotate } from "../features/rotate.js";
import { AxisLike } from "../math/axis.js";
import { SceneObject } from "../common/scene-object.js";
import { materializePartArgs } from "../features/part-args.js";
import { AxisObjectBase } from "../features/axis-renderable-base.js";
import { AxisObject } from "../features/axis.js";
import { IRotate, ISceneObject } from "./interfaces.js";
import { type NumberParam, type BooleanParam, isBooleanParam, resolveParam } from "./param.js";

interface RotateFunction {
  /**
   * Rotates objects around an axis by an angle.
   * @param axis - The axis to rotate around
   * @param angle - The rotation angle in degrees
   * @param targets - The objects to rotate (defaults to last object)
   */
  (axis: AxisLike, angle: NumberParam, ...targets: ISceneObject[]): IRotate;
  /**
   * Rotates objects around an axis by an angle, optionally making a copy.
   * @param axis - The axis to rotate around
   * @param angle - The rotation angle in degrees
   * @param copy - Whether to copy instead of move
   * @param targets - The objects to rotate (defaults to last object)
   */
  (axis: AxisLike, angle: NumberParam, copy: BooleanParam, ...targets: ISceneObject[]): IRotate;
}

function build(context: SceneParserContext): RotateFunction {
  return function rotate() {
    // Part definitions flow where built parts used to — coerce to their
    // built default variant before target extraction.
    const args = materializePartArgs(Array.from(arguments));

    // Sketch geometry is oriented by constraints (angle(), horizontal(),
    // vertical(), perpendicular()), never by a transform: a rotated copy of
    // a solved entity would have no solver identity of its own, and a moved
    // one would leave its entity invisible but still solving.
    if (context.getActiveSketch()) {
      throw new Error("rotate() is not available inside a sketch — orient sketch geometry with constraints such as angle(), horizontal() or vertical() instead. Outside a sketch, rotate(axis, angle, ...targets) turns solids.");
    }

    // Extract SceneObject targets from the end.
    const targets: SceneObject[] = [];
    while (args.length > 0 && args[args.length - 1] instanceof SceneObject) {
      targets.unshift(args.pop() as SceneObject);
    }

    // Extract copy flag from the end (if boolean)
    const copy = isBooleanParam(args[args.length - 1]) ? resolveParam(args.pop() as BooleanParam) : false;

    if (args.length === 1) {
      throw new Error("rotate() needs an axis and an angle: rotate(axis, angle, ...targets).");
    }

    // rotate(axis, angle, copy?, ...targets)
    if (args.length === 2) {
      let axis: AxisObjectBase = null;
      if (args[0] instanceof AxisObjectBase) {
        axis = args[0] as AxisObjectBase;
      } else {
        const a = normalizeAxis(args[0]);
        axis = new AxisObject(a);
        context.addSceneObject(axis);
      }

      const angle = resolveParam(args[1] as NumberParam);
      const rotate = new Rotate(axis, angle, copy, ...targets);
      context.addSceneObject(rotate);
      return rotate;
    }

    throw new Error("Invalid arguments for rotate function");
  } as RotateFunction;
}

export default registerBuilder(build);

