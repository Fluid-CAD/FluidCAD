import { registerBuilder, SceneParserContext } from "../index.js";
import { Axis, AxisLike } from "../math/axis.js";
import { SceneObject } from "../common/scene-object.js";
import { Matrix4 } from "../math/matrix4.js";
import { LazyMatrix } from "../math/lazy-matrix.js";
import { rad } from "../helpers/math-helpers.js";
import { LinearRepeatOptions, RepeatAxisSource, RepeatLinear } from "../features/repeat-linear.js";
import { CircularRepeatOptions, RepeatCircular } from "../features/repeat-circular.js";
import { cloneWithTransform } from "../helpers/clone-transform.js";
import { IRepeat, ISceneObject } from "./interfaces.js";
import { type NumberParam, isNumberParam, resolveParam } from "./param.js";
import { PlaneLike } from "../math/plane.js";
import { MirrorFeature } from "../features/mirror-feature.js";
import { RepeatMatrix } from "../features/repeat-matrix.js";
import { resolveAxis, resolvePlane } from "../helpers/resolve.js";
import { normalizeAxis } from "../helpers/normalize.js";
import { AxisObjectBase } from "../features/axis-renderable-base.js";
import { RepeatBase, RepeatSlot, RepeatSlotMatrix } from "../features/repeat-base.js";

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

/**
 * The feature a repeat with no targets repeats: the last one before it. After
 * another repeat that is the repeat itself — its whole pattern — not the last
 * clone it happened to add to the scene.
 */
function lastFeature(context: SceneParserContext): SceneObject {
  const last = context.getSceneObjects().at(-1)!;
  for (let obj: SceneObject | null = last; obj; obj = obj.getParent()) {
    if (obj instanceof RepeatBase) {
      return obj;
    }
  }
  return last;
}

/** The targets as written — the explicit ones, or the last feature before the statement. */
function writtenTargets(context: SceneParserContext, explicit: SceneObject[]): SceneObject[] {
  return explicit.length > 0 ? explicit : [lastFeature(context)];
}

/**
 * Clone `features` under `repeat`, moved by `transform`: every clone made
 * (dependency and child clones included) and, parallel to `features`, the
 * clones of the features themselves — what `instance(k)` addresses and
 * forwards accessors to.
 */
function placeInstance(
  repeat: RepeatBase,
  features: SceneObject[],
  transform: LazyMatrix,
): { clones: SceneObject[]; roots: SceneObject[] } {
  const { clones, copies } = cloneWithTransform(features, transform, repeat);
  return { clones, roots: features.map(feature => copies.get(feature)!) };
}

/**
 * Original at slot 0, the single clone at slot 1 (mirror, rotate, matrix).
 * Returns the clones to add to the scene after the repeat.
 */
function placePair(repeat: RepeatBase, features: SceneObject[], transform: LazyMatrix): SceneObject[] {
  const { clones, roots } = placeInstance(repeat, features, transform);
  repeat.setInstanceSlots([features, roots], 0, [LazyMatrix.of(Matrix4.identity()), transform]);
  return clones;
}

interface RepeatFunction {
  /**
   * Creates linear repeated instances along an axis.
   * @param type - Must be `'linear'`
   * @param axis - The axis to repeat along
   * @param options - Repeat count, spacing, etc.
   * @param objects - The objects to repeat (defaults to last object); a `repeat()` among them stands for its whole pattern
   */
  (type: 'linear', axis: AxisLike, options: LinearRepeatOptions, ...objects: ISceneObject[]): IRepeat;
  /**
   * Creates linear repeated instances along multiple axes.
   * @param type - Must be `'linear'`
   * @param axis - The axes to repeat along
   * @param options - Repeat count, spacing, etc.
   * @param objects - The objects to repeat (defaults to last object); a `repeat()` among them stands for its whole pattern
   */
  (type: 'linear', axis: AxisLike[], options: LinearRepeatOptions, ...objects: ISceneObject[]): IRepeat;

  /**
   * Creates circular repeated instances around an axis.
   * @param type - Must be `'circular'`
   * @param axis - The axis to repeat around
   * @param options - Repeat count, angle, etc.
   * @param objects - The objects to repeat (defaults to last object); a `repeat()` among them stands for its whole pattern
   */
  (type: 'circular', axis: AxisLike, options: CircularRepeatOptions, ...objects: ISceneObject[]): IRepeat;

  /**
   * Creates a mirrored instance of objects across a plane.
   * @param type - Must be `'mirror'`
   * @param plane - The plane to mirror across
   * @param objects - The objects to mirror (defaults to last object); a `repeat()` among them stands for its whole pattern
   */
  (type: 'mirror', plane: PlaneLike, ...objects: ISceneObject[]): IRepeat;

  /**
   * Creates a rotated clone of objects around an axis.
   * @param type - Must be `'rotate'`
   * @param axis - The axis to rotate around
   * @param angle - The rotation angle in degrees (defaults to 90)
   * @param objects - The objects to rotate (defaults to last object); a `repeat()` among them stands for its whole pattern
   */
  (type: 'rotate', axis: AxisLike, angle?: NumberParam, ...objects: ISceneObject[]): IRepeat;

  /**
   * Creates a transformed clone of objects using an arbitrary matrix.
   * @param matrix - The transformation matrix to apply
   * @param objects - The objects to transform (defaults to last object); a `repeat()` among them stands for its whole pattern
   */
  (matrix: Matrix4, ...objects: ISceneObject[]): IRepeat;
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
      const objects = writtenTargets(context, args.slice(1) as SceneObject[]);

      const lazy = LazyMatrix.of(matrix);
      const feature = new RepeatMatrix(lazy, objects);
      if (feature.refuseTargets(objects)) {
        context.addSceneObject(feature);
        return feature;
      }
      const cloned = placePair(feature, RepeatBase.patternFeatures(objects), lazy);

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
      const objects = writtenTargets(context, args.slice(3) as SceneObject[]);

      if (type === 'linear') {
        const counts = Array.isArray(options.count) ? options.count : [resolveParam(options.count as NumberParam)];
        const offsets = options.offset != null
          ? (Array.isArray(options.offset) ? options.offset : [resolveParam(options.offset as NumberParam)])
          : null;
        const lengths = 'length' in options && options.length != null
          ? (Array.isArray(options.length) ? options.length : [resolveParam(options.length as NumberParam)])
          : null;
        const repeat = new RepeatLinear(axisSources, options, objects);
        if (repeat.refuseTargets(objects)) {
          context.addSceneObject(repeat);
          return repeat;
        }
        const features = RepeatBase.patternFeatures(objects);

        const transformedObjects: SceneObject[] = [];
        // One slot per grid cell in combination order; the original keeps its
        // own cell, skipped cells stay null.
        const slots: RepeatSlot[] = [];
        const slotMatrices: RepeatSlotMatrix[] = [];
        let originalSlot = 0;

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
          const isOrigin = options.centered
            ? indices.every((idx, a) => idx === Math.floor(axisOffsets[a].count / 2))
            : indices.every(i => i === 0);
          if (isOrigin) {
            originalSlot = slots.length;
            slots.push(features);
            slotMatrices.push(LazyMatrix.of(Matrix4.identity()));
            continue;
          }

          // Skip if in the skip list
          if (options.skip?.some(s =>
            s.length === indices.length && s.every((v, i) => v === indices[i])
          )) {
            slots.push(null);
            slotMatrices.push(null);
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

          const { clones, roots } = placeInstance(repeat, features, lazy);
          transformedObjects.push(...clones);
          slots.push(roots);
          slotMatrices.push(lazy);
        }

        repeat.setInstanceSlots(slots, originalSlot, slotMatrices);
        context.addSceneObject(repeat);
        context.addSceneObjects(transformedObjects);
        return repeat;
      }

      if (type === 'circular') {
        const axis = axisSources[0];
        const circularOptions = options as unknown as CircularRepeatOptions;
        const count = resolveParam(circularOptions.count as NumberParam);
        const { centered, skip } = circularOptions;

        const repeat = new RepeatCircular(axis, circularOptions, objects);
        if (repeat.refuseTargets(objects)) {
          context.addSceneObject(repeat);
          return repeat;
        }
        const features = RepeatBase.patternFeatures(objects);

        let offset: number;
        if ('offset' in circularOptions && circularOptions.offset !== undefined) {
          offset = resolveParam(circularOptions.offset as NumberParam);
        } else {
          const angle = resolveParam((circularOptions as { angle: NumberParam }).angle);
          offset = angle % 360 === 0 ? angle / count : angle / (count - 1);
        }

        const startOffset = centered ? -(count * offset) / 2 : 0;

        const transformedObjects: SceneObject[] = [];
        // Rotation step i is slot i; the original is step 0.
        const slots: RepeatSlot[] = [features];
        const slotMatrices: RepeatSlotMatrix[] = [LazyMatrix.of(Matrix4.identity())];

        for (let i = 1; i < count; i++) {
          if (skip?.includes(i)) {
            slots.push(null);
            slotMatrices.push(null);
            continue;
          }

          const angle = startOffset + offset * i;
          const lazy = LazyMatrix.rotation(axis, rad(angle));

          const { clones, roots } = placeInstance(repeat, features, lazy);
          transformedObjects.push(...clones);
          slots.push(roots);
          slotMatrices.push(lazy);
        }

        repeat.setInstanceSlots(slots, 0, slotMatrices);
        context.addSceneObject(repeat);
        context.addSceneObjects(transformedObjects);
        return repeat;
      }
    }

    if (type === 'mirror') {
      const planeArg = args[1] as PlaneLike;
      const targetObjects = writtenTargets(context, args.slice(2) as SceneObject[]);

      const planeObj = resolvePlane(planeArg, context);
      const lazy = LazyMatrix.mirror(planeObj);
      const mirrorFeature = new MirrorFeature(planeObj, lazy, targetObjects);
      if (mirrorFeature.refuseTargets(targetObjects)) {
        context.addSceneObject(mirrorFeature);
        return mirrorFeature;
      }
      const mirrorTree = placePair(mirrorFeature, RepeatBase.patternFeatures(targetObjects), lazy);

      context.addSceneObject(mirrorFeature);
      context.addSceneObjects(mirrorTree);
      return mirrorFeature;
    }

    if (type === 'rotate') {
      const axisArg = args[1] as AxisLike;
      let angle = 90;
      let restStart = 2;

      if (isNumberParam(args[2])) {
        angle = resolveParam(args[2] as NumberParam);
        restStart = 3;
      }

      const objects = writtenTargets(context, args.slice(restStart) as SceneObject[]);

      const axis = resolveRepeatAxis(axisArg, context);
      const lazy = LazyMatrix.rotation(axis, rad(angle));
      const sources = axis instanceof AxisObjectBase ? [axis] : [];
      const feature = new RepeatMatrix(lazy, objects, sources);
      if (feature.refuseTargets(objects)) {
        context.addSceneObject(feature);
        return feature;
      }
      const cloned = placePair(feature, RepeatBase.patternFeatures(objects), lazy);

      context.addSceneObject(feature);
      context.addSceneObjects(cloned);
      return feature;
    }

    throw new Error(`Invalid repeat type: ${type}`);
  }) as RepeatFunction;
}

export default registerBuilder(build);
