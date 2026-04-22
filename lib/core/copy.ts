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
import { ISceneObject } from "./interfaces.js";

export type CopyType = 'linear' | 'circular';

interface CopyFunction {
  /**
   * [2D] Creates linear copies along an axis inside a sketch.
   * @param type - Must be `'linear'`
   * @param axis - The axis to copy along
   * @param options - Copy count, spacing, etc.
   * @param objects - The objects to copy (defaults to last object)
   */
  (type: 'linear', axis: AxisLike, options: LinearCopyOptions, ...objects: ISceneObject[]): ISceneObject;
  /**
   * [2D] Creates linear copies along multiple axes inside a sketch.
   * @param type - Must be `'linear'`
   * @param axis - The axes to copy along
   * @param options - Copy count, spacing, etc.
   * @param objects - The objects to copy (defaults to last object)
   */
  (type: 'linear', axis: AxisLike[], options: LinearCopyOptions, ...objects: ISceneObject[]): ISceneObject;

  /**
   * [3D] Creates linear copies along an axis.
   * @param type - Must be `'linear'`
   * @param axis - The axis to copy along
   * @param options - Copy count, spacing, etc.
   * @param objects - The objects to copy (defaults to last object)
   */
  (type: 'linear', axis: AxisLike, options: LinearCopyOptions, ...objects: ISceneObject[]): ISceneObject;
  /**
   * [3D] Creates linear copies along multiple axes.
   * @param type - Must be `'linear'`
   * @param axis - The axes to copy along
   * @param options - Copy count, spacing, etc.
   * @param objects - The objects to copy (defaults to last object)
   */
  (type: 'linear', axis: AxisLike[], options: LinearCopyOptions, ...objects: ISceneObject[]): ISceneObject;

  /**
   * [2D] Creates circular copies around a center point inside a sketch.
   * @param type - Must be `'circular'`
   * @param center - The center point to copy around
   * @param options - Copy count, angle, etc.
   * @param objects - The objects to copy (defaults to last object)
   */
  (type: 'circular', center: Point2DLike, options: CircularCopyOptions, ...objects: ISceneObject[]): ISceneObject;

  /**
   * [3D] Creates circular copies around an axis.
   * @param type - Must be `'circular'`
   * @param axis - The axis to copy around
   * @param options - Copy count, angle, etc.
   * @param objects - The objects to copy (defaults to last object)
   */
  (type: 'circular', axis: AxisLike, options: CircularCopyOptions, ...objects: ISceneObject[]): ISceneObject;
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

      const axes = axisList.map(a => normalizeAxis(a));
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

      const axis = normalizeAxis(args[1] as AxisLike);
      const copy = new CopyCircular(axis, options as CircularCopyOptions, objects);
      context.addSceneObject(copy);
      return copy;
    }

    throw new Error(`Invalid copy type: ${type}`);
  } as CopyFunction;
}

export default registerBuilder(build);
