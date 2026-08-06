import { registerBuilder, SceneParserContext } from "../index.js";
import { normalizeAxis, normalizePoint2D } from "../helpers/normalize.js";
import { AxisLike } from "../math/axis.js";
import { Point2DLike } from "../math/point.js";
import { SceneObject } from "../common/scene-object.js";
import { CopyLinear, LinearCopyOptions } from "../features/copy-linear.js";
import { CopyCircular, CircularCopyOptions } from "../features/copy-circular.js";
import { CopyLinear2D, CopyLinear2DAxis } from "../features/copy-linear2d.js";
import { CopyCircular2D } from "../features/copy-circular2d.js";
import { AxisObjectBase } from "../features/axis-renderable-base.js";
import { CopyAxisSource } from "../features/copy-base.js";
import { Axis } from "../math/axis.js";
import { resolveAxis } from "../helpers/resolve.js";
import { ICopy, ISceneObject } from "./interfaces.js";

export type CopyType = 'linear' | 'circular';

/**
 * Resolve a 3D copy axis argument. Scene-resident sources (an axis object or
 * an edge SceneObject) stay scene objects — they get built before the copy
 * that consumes them; primitive inputs (world-axis string, raw Axis) stay
 * concrete Axis values with no extra scene object.
 */
function resolveCopyAxis(arg: unknown, context: SceneParserContext): CopyAxisSource {
  if (arg instanceof AxisObjectBase) {
    return arg;
  }
  if (arg instanceof SceneObject) {
    return resolveAxis(arg, context);
  }
  if (arg instanceof Axis) {
    return arg;
  }
  return normalizeAxis(arg as AxisLike);
}

interface CopyFunction {
  /**
   * [2D] Creates linear copies along an axis inside a sketch.
   * @param type - Must be `'linear'`
   * @param axis - The axis to copy along
   * @param options - Copy count, spacing, etc.
   * @param objects - The objects to copy (defaults to last object)
   */
  (type: 'linear', axis: AxisLike, options: LinearCopyOptions, ...objects: ISceneObject[]): ICopy;
  /**
   * [2D] Creates linear copies along multiple axes inside a sketch.
   * @param type - Must be `'linear'`
   * @param axis - The axes to copy along
   * @param options - Copy count, spacing, etc.
   * @param objects - The objects to copy (defaults to last object)
   */
  (type: 'linear', axis: AxisLike[], options: LinearCopyOptions, ...objects: ISceneObject[]): ICopy;

  /**
   * [3D] Creates linear copies along an axis.
   * @param type - Must be `'linear'`
   * @param axis - The axis to copy along
   * @param options - Copy count, spacing, etc.
   * @param objects - The objects to copy (defaults to last object)
   */
  (type: 'linear', axis: AxisLike, options: LinearCopyOptions, ...objects: ISceneObject[]): ICopy;
  /**
   * [3D] Creates linear copies along multiple axes.
   * @param type - Must be `'linear'`
   * @param axis - The axes to copy along
   * @param options - Copy count, spacing, etc.
   * @param objects - The objects to copy (defaults to last object)
   */
  (type: 'linear', axis: AxisLike[], options: LinearCopyOptions, ...objects: ISceneObject[]): ICopy;

  /**
   * [2D] Creates circular copies around a center point inside a sketch.
   * @param type - Must be `'circular'`
   * @param center - The center point to copy around
   * @param options - Copy count, angle, etc.
   * @param objects - The objects to copy (defaults to last object)
   */
  (type: 'circular', center: Point2DLike, options: CircularCopyOptions, ...objects: ISceneObject[]): ICopy;

  /**
   * [3D] Creates circular copies around an axis.
   * @param type - Must be `'circular'`
   * @param axis - The axis to copy around
   * @param options - Copy count, angle, etc.
   * @param objects - The objects to copy (defaults to last object)
   */
  (type: 'circular', axis: AxisLike, options: CircularCopyOptions, ...objects: ISceneObject[]): ICopy;
}

function build(context: SceneParserContext): CopyFunction {
  return function copy() {
    const args = Array.from(arguments);

    if (args.length < 3) {
      throw new Error("Invalid arguments for copy function: expected at least (type, axis, options)");
    }

    const type = args[0] as CopyType;
    const activeSketch = context.getActiveSketch();
    const options = args[2] as LinearCopyOptions | CircularCopyOptions;
    const restObjects = args.slice(3) as SceneObject[];
    const objects = restObjects.length > 0
      ? restObjects
      : null;

    if (type === 'linear') {
      const axisArg = args[1] as AxisLike | AxisLike[];
      const axisList = Array.isArray(axisArg) ? axisArg : [axisArg];

      if (activeSketch) {
        const sketchAxes: CopyLinear2DAxis[] = axisList.map(a =>
          a instanceof AxisObjectBase ? a : normalizeAxis(a)
        );
        const copy = new CopyLinear2D(sketchAxes, options as LinearCopyOptions, restObjects.length > 0 ? restObjects : null);
        context.addSceneObject(copy);
        return copy;
      }

      const axes = axisList.map(a => resolveCopyAxis(a, context));
      const copy = new CopyLinear(axes, options as LinearCopyOptions, objects);
      context.addSceneObject(copy);
      return copy;
    }

    if (type === 'circular') {
      if (activeSketch) {
        const center = normalizePoint2D(args[1] as Point2DLike);
        const copy = new CopyCircular2D(center, options as CircularCopyOptions, restObjects.length > 0 ? restObjects : null);
        context.addSceneObject(copy);
        return copy;
      }

      const axis = resolveCopyAxis(args[1], context);
      const copy = new CopyCircular(axis, options as CircularCopyOptions, objects);
      context.addSceneObject(copy);
      return copy;
    }

    throw new Error(`Invalid copy type: ${type}`);
  } as CopyFunction;
}

export default registerBuilder(build);
