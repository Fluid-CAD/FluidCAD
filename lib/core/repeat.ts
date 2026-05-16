import { registerBuilder, SceneParserContext } from "../index.js";
import { Axis, AxisLike } from "../math/axis.js";
import { SceneObject } from "../common/scene-object.js";
import { Matrix4 } from "../math/matrix4.js";
import { LazyMatrix } from "../math/lazy-matrix.js";
import { rad } from "../helpers/math-helpers.js";
import { LinearRepeatOptions, RepeatAxisSource, RepeatLinear } from "../features/repeat-linear.js";
import { CircularRepeatOptions, RepeatCircular } from "../features/repeat-circular.js";
import { cloneWithTransform } from "../helpers/clone-transform.js";
import { ISceneObject } from "./interfaces.js";
import { PlaneLike } from "../math/plane.js";
import { MirrorFeature } from "../features/mirror-feature.js";
import { RepeatMatrix } from "../features/repeat-matrix.js";
import { resolveAxis, resolvePlane } from "../helpers/resolve.js";
import { normalizeAxis } from "../helpers/normalize.js";
import { AxisObjectBase } from "../features/axis-renderable-base.js";

/**
 * Resolve a repeat axis argument to a value usable by LazyMatrix. Scene-
 * resident sources (AxisObjectBase or an edge SceneObject) go through
 * resolveAxis so they end up in the scene and get built before consumers.
 * Primitive inputs (world-axis string, raw Axis) stay as concrete Axis
 * values — no extra scene object, no rendered world-axis line.
 */
function resolveRepeatAxis(arg: unknown, context: SceneParserContext): RepeatAxisSource {
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

export type RepeatType = 'linear' | 'circular' | 'mirror' | 'rotate';

interface RepeatFunction {
  /**
   * Creates linear repeated instances along an axis.
   * @param type - Must be `'linear'`
   * @param axis - The axis to repeat along
   * @param options - Repeat count, spacing, etc.
   * @param objects - The objects to repeat (defaults to last object)
   */
  (type: 'linear', axis: AxisLike, options: LinearRepeatOptions, ...objects: ISceneObject[]): ISceneObject;
  /**
   * Creates linear repeated instances along multiple axes.
   * @param type - Must be `'linear'`
   * @param axis - The axes to repeat along
   * @param options - Repeat count, spacing, etc.
   * @param objects - The objects to repeat (defaults to last object)
   */
  (type: 'linear', axis: AxisLike[], options: LinearRepeatOptions, ...objects: ISceneObject[]): ISceneObject;

  /**
   * Creates circular repeated instances around an axis.
   * @param type - Must be `'circular'`
   * @param axis - The axis to repeat around
   * @param options - Repeat count, angle, etc.
   * @param objects - The objects to repeat (defaults to last object)
   */
  (type: 'circular', axis: AxisLike, options: CircularRepeatOptions, ...objects: ISceneObject[]): ISceneObject;

  /**
   * Creates a mirrored instance of objects across a plane.
   * @param type - Must be `'mirror'`
   * @param plane - The plane to mirror across
   * @param objects - The objects to mirror (defaults to last object)
   */
  (type: 'mirror', plane: PlaneLike, ...objects: ISceneObject[]): ISceneObject;

  /**
   * Creates a rotated clone of objects around an axis.
   * @param type - Must be `'rotate'`
   * @param axis - The axis to rotate around
   * @param angle - The rotation angle in degrees (defaults to 90)
   * @param objects - The objects to rotate (defaults to last object)
   */
  (type: 'rotate', axis: AxisLike, angle?: number, ...objects: ISceneObject[]): ISceneObject;

  /**
   * Creates a transformed clone of objects using an arbitrary matrix.
   * @param matrix - The transformation matrix to apply
   * @param objects - The objects to transform (defaults to last object)
   */
  (matrix: Matrix4, ...objects: ISceneObject[]): ISceneObject;
}

function build(context: SceneParserContext): RepeatFunction {
  return (function repeat() {
    const args = Array.from(arguments);

    const sketch = context.getActiveSketch();
    if (sketch) {
      throw new Error("Cannot call repeat() inside a sketch. Use copy() instead.")
    }

    if (args[0] instanceof Matrix4) {
      const matrix = args[0] as Matrix4;
      const restObjects = args.slice(1) as SceneObject[];
      const objects = restObjects.length > 0
        ? restObjects
        : [context.getSceneObjects().at(-1)!];

      const lazy = LazyMatrix.of(matrix);
      const feature = new RepeatMatrix(lazy, objects);
      const cloned = cloneWithTransform(objects, lazy, feature);

      context.addSceneObject(feature);
      context.addSceneObjects(cloned);
      return feature;
    }

    if (args.length < 2) {
      throw new Error("Invalid arguments for repeat function: expected at least (type, ...)");
    }

    const type = args[0] as RepeatType;

    if (type === 'linear' || type === 'circular') {
      const axisArg = args[1] as AxisLike | AxisLike[];

      const axisSources: RepeatAxisSource[] = Array.isArray(axisArg)
        ? axisArg.map(a => resolveRepeatAxis(a, context))
        : [resolveRepeatAxis(axisArg, context)];

      const options = args[2] as LinearRepeatOptions;
      const restObjects = args.slice(3) as SceneObject[];
      const objects = restObjects.length > 0
        ? restObjects
        : [context.getSceneObjects().at(-1)!];

      if (type === 'linear') {
        const counts = Array.isArray(options.count) ? options.count : [options.count];
        const offsets = options.offset != null
          ? (Array.isArray(options.offset) ? options.offset : [options.offset])
          : null;
        const lengths = 'length' in options && options.length != null
          ? (Array.isArray(options.length) ? options.length : [options.length])
          : null;
        const repeat = new RepeatLinear(axisSources, options, objects);

        const transformedObjects: SceneObject[] = [];

        const axisOffsets = axisSources.map((axis, i) => {
          const count = counts[i] ?? counts[0];
          const offset = offsets != null
            ? (offsets[i] ?? offsets[0])
            : (lengths![i] ?? lengths![0]) / (count - 1);
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
          // Skip the origin instance
          if (options.centered) {
            if (indices.every((idx, a) => idx === Math.floor(axisOffsets[a].count / 2))) {
              continue;
            }
          } else {
            if (indices.every(i => i === 0)) {
              continue;
            }
          }

          // Skip if in the skip list
          if (options.skip?.some(s =>
            s.length === indices.length && s.every((v, i) => v === indices[i])
          )) {
            continue;
          }

          // Capture per-axis offset + signed index for this instance; the
          // axis direction is read lazily at build time so an AxisObjectBase
          // can still be unbuilt at parse time.
          const perAxis = axisOffsets.map((entry, a) => {
            const idx = options.centered
              ? indices[a] - Math.floor(entry.count / 2)
              : indices[a];
            return { axis: entry.axis, offset: entry.offset, idx };
          });

          const lazy = LazyMatrix.from(() => {
            let dx = 0, dy = 0, dz = 0;
            for (const { axis, offset, idx } of perAxis) {
              const dir = (axis instanceof AxisObjectBase ? axis.getAxis() : axis).direction;
              dx += dir.x * offset * idx;
              dy += dir.y * offset * idx;
              dz += dir.z * offset * idx;
            }
            return Matrix4.fromTranslation(dx, dy, dz);
          });

          const cloned = cloneWithTransform(objects, lazy, repeat);
          transformedObjects.push(...cloned);
        }

        context.addSceneObject(repeat);
        context.addSceneObjects(transformedObjects);
        return repeat;
      }

      if (type === 'circular') {
        const axis = axisSources[0];
        const circularOptions = options as unknown as CircularRepeatOptions;
        const { count, centered, skip } = circularOptions;

        const repeat = new RepeatCircular(axis, circularOptions, objects);

        let offset: number;
        if ('offset' in circularOptions && circularOptions.offset !== undefined) {
          offset = circularOptions.offset;
        } else {
          const angle = (circularOptions as { angle: number }).angle;
          offset = angle % 360 === 0 ? angle / count : angle / (count - 1);
        }

        const startOffset = centered ? -(count * offset) / 2 : 0;

        const transformedObjects: SceneObject[] = [];

        for (let i = 1; i < count; i++) {
          if (skip?.includes(i)) {
            continue;
          }

          const angle = startOffset + offset * i;
          const lazy = LazyMatrix.rotation(axis, rad(angle));

          const cloned = cloneWithTransform(objects, lazy, repeat);
          transformedObjects.push(...cloned);
        }

        context.addSceneObject(repeat);
        context.addSceneObjects(transformedObjects);
        return repeat;
      }
    }

    if (type === 'mirror') {
      const planeArg = args[1] as PlaneLike;
      const restObjects = args.slice(2) as SceneObject[];
      const targetObjects = restObjects.length > 0
        ? restObjects
        : [context.getSceneObjects().at(-1)!];

      const planeObj = resolvePlane(planeArg, context);
      const lazy = LazyMatrix.mirror(planeObj);
      const mirrorFeature = new MirrorFeature(planeObj, lazy);
      const mirrorTree = cloneWithTransform(targetObjects, lazy, mirrorFeature);

      context.addSceneObject(mirrorFeature);
      context.addSceneObjects(mirrorTree);
      return mirrorFeature;
    }

    if (type === 'rotate') {
      const axisArg = args[1] as AxisLike;
      let angle = 90;
      let restStart = 2;

      if (typeof args[2] === 'number') {
        angle = args[2];
        restStart = 3;
      }

      const restObjects = args.slice(restStart) as SceneObject[];
      const objects = restObjects.length > 0
        ? restObjects
        : [context.getSceneObjects().at(-1)!];

      const axis = resolveRepeatAxis(axisArg, context);
      const lazy = LazyMatrix.rotation(axis, rad(angle));
      const sources = axis instanceof AxisObjectBase ? [axis] : [];
      const feature = new RepeatMatrix(lazy, objects, sources);
      const cloned = cloneWithTransform(objects, lazy, feature);

      context.addSceneObject(feature);
      context.addSceneObjects(cloned);
      return feature;
    }

    throw new Error(`Invalid repeat type: ${type}`);
  }) as RepeatFunction;
}

export default registerBuilder(build);
