import { registerBuilder, SceneParserContext } from "../index.js";
import { normalizeAxis } from "../helpers/normalize.js";
import { AxisLike } from "../math/axis.js";
import { SceneObject } from "../common/scene-object.js";
import { Matrix4 } from "../math/matrix4.js";
import { rad } from "../helpers/math-helpers.js";
import { LinearRepeatOptions, RepeatLinear } from "../features/repeat-linear.js";
import { CircularRepeatOptions, RepeatCircular } from "../features/repeat-circular.js";
import { cloneWithTransform } from "../helpers/clone-transform.js";

export type RepeatType = 'linear' | 'circular';

interface RepeatFunction {
  (type: 'linear', axis: AxisLike, options: LinearRepeatOptions, ...objects: SceneObject[]): RepeatLinear;
  (type: 'linear', axis: AxisLike[], options: LinearRepeatOptions, ...objects: SceneObject[]): RepeatLinear;

  (type: 'circular', axis: AxisLike, options: CircularRepeatOptions, ...objects: SceneObject[]): RepeatCircular;
}

function build(context: SceneParserContext): RepeatFunction {
  return (function repeat() {
    const args = Array.from(arguments);

    if (args.length < 3) {
      throw new Error("Invalid arguments for repeat function: expected at least (type, axis, options)");
    }

    const sketch = context.getActiveSketch();
    if (sketch) {
      throw new Error("Cannot call repeat() inside a sketch. Use copy() instead.")
    }

    const type = args[0] as RepeatType;
    const axisArg = args[1] as AxisLike | AxisLike[];

    const axes = Array.isArray(axisArg)
      ? axisArg.map(a => normalizeAxis(a))
      : [normalizeAxis(axisArg)];

    const options = args[2] as LinearRepeatOptions;
    const restObjects = args.slice(3) as SceneObject[];
    const objects = restObjects.length > 0
      ? restObjects
      : [context.getSceneObjects().at(-1)!];

    if (type === 'linear') {
      const counts = Array.isArray(options.count) ? options.count : [options.count];
      const repeat = new RepeatLinear(axes, options, objects);

      const transformedObjects: SceneObject[] = [];

      const axisOffsets = axes.map((axis, i) => {
        const count = counts[i] ?? counts[0];
        const offset = options.offset != null
          ? options.offset
          : options.length / (count - 1);
        return { axis, count, offset };
      });

      // Generate all index combinations across axes
      const indexCombinations: number[][] = [[]];
      for (const { count } of axisOffsets) {
        const newCombinations: number[][] = [];
        for (const combo of indexCombinations) {
          for (let i = 0; i < count; i++) {
            newCombinations.push([...combo, i]);
          }
        }
        indexCombinations.length = 0;
        indexCombinations.push(...newCombinations);
      }

      for (const indices of indexCombinations) {
        // Skip the origin instance (all zeros)
        if (indices.every(i => i === 0)) {
          continue;
        }

        // Skip if in the skip list
        if (options.skip?.some(s =>
          s.length === indices.length && s.every((v, i) => v === indices[i])
        )) {
          continue;
        }

        // Compose translation from all axes
        let dx = 0, dy = 0, dz = 0;
        for (let a = 0; a < axisOffsets.length; a++) {
          const { axis, offset } = axisOffsets[a];
          const idx = options.centered
            ? indices[a] - Math.floor(axisOffsets[a].count / 2)
            : indices[a];
          dx += axis.direction.x * offset * idx;
          dy += axis.direction.y * offset * idx;
          dz += axis.direction.z * offset * idx;
        }

        const transform = Matrix4.fromTranslation(dx, dy, dz);
        console.log('Translating by', { dx, dy, dz }, 'for indices', indices);

        const cloned = cloneWithTransform(objects, transform, repeat);
        transformedObjects.push(...cloned);
      }

      context.addSceneObject(repeat);
      context.addSceneObjects(transformedObjects);
      return repeat;
    }

    if (type === 'circular') {
      const axis = axes[0];
      const circularOptions = options as unknown as CircularRepeatOptions;
      const { count, centered, skip } = circularOptions;

      const repeat = new RepeatCircular(axis, circularOptions, objects);

      let offset: number;
      if ('offset' in circularOptions && circularOptions.offset !== undefined) {
        offset = circularOptions.offset;
      } else {
        offset = (circularOptions as { angle: number }).angle / (count - 1);
      }

      const startOffset = centered ? -(count * offset) / 2 : 0;

      const transformedObjects: SceneObject[] = [];

      for (let i = 1; i < count; i++) {
        if (skip?.includes(i)) {
          continue;
        }

        const angle = startOffset + offset * i;
        const matrix = Matrix4.fromRotationAroundAxis(axis.origin, axis.direction, rad(angle));

        const cloned = cloneWithTransform(objects, matrix, repeat);
        transformedObjects.push(...cloned);
      }

      context.addSceneObject(repeat);
      context.addSceneObjects(transformedObjects);
      return repeat;
    }

    throw new Error(`Invalid repeat type: ${type}`);
  }) as RepeatFunction;
}

export default registerBuilder(build);
