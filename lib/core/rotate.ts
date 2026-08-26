import { registerBuilder, SceneParserContext } from "../index.js";
import { normalizeAxis, normalizePoint2D } from "../helpers/normalize.js";
import { Point2DLike } from "../math/point.js";
import { Rotate } from "../features/rotate.js";
import { AxisLike } from "../math/axis.js";
import { SceneObject } from "../common/scene-object.js";
import { materializePartArgs } from "../features/part-args.js";
import { AxisObjectBase } from "../features/axis-renderable-base.js";
import { AxisObject } from "../features/axis.js";
import { Rotate2D } from "../features/rotate2d.js";
import { LazyVertex } from "../features/lazy-vertex.js";
import { IRotate, ISceneObject } from "./interfaces.js";
import { type NumberParam, type BooleanParam, isBooleanParam, resolveParam } from "./param.js";

interface RotateFunction {
  /**
   * [2D] Rotates geometry by an angle inside a sketch, about the sketch
   * cursor (legacy sketches only — constraint sketches require an explicit
   * center).
   * @param angle - The rotation angle in degrees
   * @param targets - The geometries to rotate (defaults to last object)
   */
  (angle: NumberParam, ...targets: ISceneObject[]): IRotate;
  /**
   * [2D] Rotates geometry by an angle about an explicit center point.
   * @param angle - The rotation angle in degrees
   * @param center - The rotation center in sketch coordinates
   * @param targets - The geometries to rotate (defaults to last object)
   */
  (angle: NumberParam, center: Point2DLike, ...targets: ISceneObject[]): IRotate;
  /**
   * [2D] Rotates geometry by an angle inside a sketch, optionally making a
   * copy (legacy sketches only — constraint sketches require an explicit
   * center).
   * @param angle - The rotation angle in degrees
   * @param copy - Whether to copy instead of move
   * @param targets - The geometries to rotate (defaults to last object)
   */
  (angle: NumberParam, copy: BooleanParam, ...targets: ISceneObject[]): IRotate;
  /**
   * [2D] Rotates geometry by an angle about an explicit center point,
   * optionally making a copy.
   * @param angle - The rotation angle in degrees
   * @param center - The rotation center in sketch coordinates
   * @param copy - Whether to copy instead of move
   * @param targets - The geometries to rotate (defaults to last object)
   */
  (angle: NumberParam, center: Point2DLike, copy: BooleanParam, ...targets: ISceneObject[]): IRotate;

  /**
   * [3D] Rotates objects around an axis by an angle.
   * @param axis - The axis to rotate around
   * @param angle - The rotation angle in degrees
   * @param targets - The objects to rotate (defaults to last object)
   */
  (axis: AxisLike, angle: NumberParam, ...targets: ISceneObject[]): IRotate;
  /**
   * [3D] Rotates objects around an axis by an angle, optionally making a copy.
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
    const activeSketch = context.getActiveSketch();

    // Extract SceneObject targets from the end. A LazyVertex is a point
    // value — an accessor center like l.end() — never a rotate target, so
    // it stays in place for the center argument below.
    const targets: SceneObject[] = [];
    while (args.length > 0 && args[args.length - 1] instanceof SceneObject
      && !(args[args.length - 1] instanceof LazyVertex)) {
      targets.unshift(args.pop() as SceneObject);
    }

    // Extract copy flag from the end (if boolean)
    const copy = isBooleanParam(args[args.length - 1]) ? resolveParam(args.pop() as BooleanParam) : false;

    // 2D: rotate(angle, center?, copy?, ...targets) — inside a sketch the
    // second argument is a rotation center, never an axis.
    if (activeSketch && (args.length === 1 || args.length === 2)) {
      const angle = resolveParam(args[0] as NumberParam);
      const center = args.length === 2 ? normalizePoint2D(args[1] as Point2DLike) : null;
      const rotate = new Rotate2D(angle, center, copy, ...targets);
      context.addSceneObject(rotate);
      return rotate;
    }

    if (args.length === 1) {
      throw new Error("rotate(angle) is only valid inside a sketch. For 3D rotation, specify an axis: rotate(axis, angle).");
    }

    if (activeSketch) {
      throw new Error("Cannot specify an axis for rotate inside a sketch. Use rotate(angle, [x, y]) instead.");
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

      const angle = resolveParam(args[1] as NumberParam);
      const rotate = new Rotate(axis, angle, copy, ...targets);
      context.addSceneObject(rotate);
      return rotate;
    }

    throw new Error("Invalid arguments for rotate function");
  } as RotateFunction;
}

export default registerBuilder(build);

