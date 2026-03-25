import { registerBuilder, SceneParserContext } from "../index.js";
import { normalizeAxis, normalizePoint2D } from "../helpers/normalize.js";
import { AxisLike } from "../math/axis.js";
import { Point2DLike } from "../math/point.js";
import { SceneObject } from "../common/scene-object.js";
import { CopyLinear, LinearCopyOptions } from "../features/copy-linear.js";
import { CopyCircular, CircularCopyOptions } from "../features/copy-circular.js";
import { CopyLinear2D } from "../features/copy-linear2d.js";
import { CopyCircular2D } from "../features/copy-circular2d.js";
import { ISceneObject } from "./interfaces.js";

export type CopyType = 'linear' | 'circular';

interface CopyFunction {
  // 2D linear (inside sketch)
  (type: 'linear', axis: AxisLike, options: LinearCopyOptions, ...objects: ISceneObject[]): ISceneObject;
  (type: 'linear', axis: AxisLike[], options: LinearCopyOptions, ...objects: ISceneObject[]): ISceneObject;

  // 3D linear
  (type: 'linear', axis: AxisLike, options: LinearCopyOptions, ...objects: ISceneObject[]): ISceneObject;
  (type: 'linear', axis: AxisLike[], options: LinearCopyOptions, ...objects: ISceneObject[]): ISceneObject;

  // 2D circular (Point2DLike center, inside sketch)
  (type: 'circular', center: Point2DLike, options: CircularCopyOptions, ...objects: ISceneObject[]): ISceneObject;

  // 3D circular
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
      : [context.getSceneObjects().at(-1)!];

    if (type === 'linear') {
      const axisArg = args[1] as AxisLike | AxisLike[];
      const axes = Array.isArray(axisArg)
        ? axisArg.map(a => normalizeAxis(a))
        : [normalizeAxis(axisArg)];

      if (activeSketch) {
        const copy = new CopyLinear2D(axes, options as LinearCopyOptions, restObjects.length > 0 ? restObjects : null);
        context.addSceneObject(copy);
        return copy;
      }

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
