import { registerBuilder, SceneParserContext } from "../index.js";
import { normalizeAxis } from "../helpers/normalize.js";
import { AxisLike } from "../math/axis.js";
import { SceneObject } from "../common/scene-object.js";
import { CopyLinear, LinearCopyOptions } from "../features/copy-linear.js";
import { CopyCircular, CircularCopyOptions } from "../features/copy-circular.js";

export type CopyType = 'linear' | 'circular';

interface CopyFunction {
  (type: 'linear', axis: AxisLike, options: LinearCopyOptions): CopyLinear;
  (type: 'linear', axis: AxisLike[], options: LinearCopyOptions): CopyLinear;
  (type: 'linear', axis: AxisLike, objects: SceneObject[], options: LinearCopyOptions): CopyLinear;
  (type: 'linear', axis: AxisLike[], objects: SceneObject[], options: LinearCopyOptions): CopyLinear;

  (type: 'circular', axis: AxisLike, options: CircularCopyOptions): CopyCircular;
  (type: 'circular', axis: AxisLike, objects: SceneObject[], options: CircularCopyOptions): CopyCircular;
}

function build(context: SceneParserContext): CopyFunction {
  return function copy() {
    const args = Array.from(arguments);

    if (args.length < 3) {
      throw new Error("Invalid arguments for copy function: expected at least (type, axis, options)");
    }

    const type = args[0] as CopyType;
    const axisArg = args[1] as AxisLike | AxisLike[];

    const axes = Array.isArray(axisArg)
      ? axisArg.map(a => normalizeAxis(a))
      : [normalizeAxis(axisArg)];

    let objects: SceneObject[] | null = null;
    let options: LinearCopyOptions | CircularCopyOptions;

    // copy(type, axis, objects[], options) vs copy(type, axis, options)
    if (Array.isArray(args[2])) {
      objects = args[2] as SceneObject[];
      options = args[3] as LinearCopyOptions | CircularCopyOptions;
    } else {
      options = args[2] as LinearCopyOptions | CircularCopyOptions;
    }

    if (type === 'linear') {
      const copy = new CopyLinear(axes, options as LinearCopyOptions);
      if (objects) {
        copy.target(...objects);
      }
      context.addSceneObject(copy);
      return copy;
    }

    if (type === 'circular') {
      const copy = new CopyCircular(axes[0], options as CircularCopyOptions);
      if (objects) {
        copy.target(...objects);
      }
      context.addSceneObject(copy);
      return copy;
    }

    throw new Error(`Invalid copy type: ${type}`);
  } as CopyFunction;
}

export default registerBuilder(build);
