import { registerBuilder, SceneParserContext } from "../index.js";
import { normalizeAxis, normalizePlane } from "../helpers/normalize.js";
import { AxisLike } from "../math/axis.js";
import { SceneObject } from "../common/scene-object.js";
import { Matrix4 } from "../math/matrix4.js";
import { rad } from "../helpers/math-helpers.js";
import { LinearRepeatOptions, RepeatLinear } from "../features/repeat-linear.js";
import { CircularRepeatOptions, RepeatCircular } from "../features/repeat-circular.js";
import { cloneWithTransform } from "../helpers/clone-transform.js";
import { ISceneObject } from "./interfaces.js";
import { Plane, PlaneLike } from "../math/plane.js";
import { PlaneObjectBase } from "../features/plane-renderable-base.js";
import { PlaneObject } from "../features/plane.js";
import { MirrorFeature } from "../features/mirror-feature.js";
import { RepeatMatrix } from "../features/repeat-matrix.js";
import { AxisObjectBase } from "../features/axis-renderable-base.js";

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

      const feature = new RepeatMatrix(matrix, objects);
      const cloned = cloneWithTransform(objects, matrix, feature);

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
        const offsets = options.offset != null
          ? (Array.isArray(options.offset) ? options.offset : [options.offset])
          : null;
        const lengths = 'length' in options && options.length != null
          ? (Array.isArray(options.length) ? options.length : [options.length])
          : null;
        const repeat = new RepeatLinear(axes, options, objects);

        const transformedObjects: SceneObject[] = [];

        const axisOffsets = axes.map((axis, i) => {
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
    }

    if (type === 'mirror') {
      const planeArg = args[1] as PlaneLike;
      const restObjects = args.slice(2) as SceneObject[];
      const targetObjects = restObjects.length > 0
        ? restObjects
        : [context.getSceneObjects().at(-1)!];

      let planeObj: PlaneObjectBase;
      let normalizedPlane: Plane;
      if (planeArg instanceof PlaneObjectBase) {
        planeObj = planeArg as PlaneObjectBase;
        planeObj.build();
        normalizedPlane = planeObj.getPlane();
      } else {
        normalizedPlane = normalizePlane(planeArg);
        planeObj = new PlaneObject(normalizedPlane);
        planeObj.build();
        context.addSceneObject(planeObj);
      }

      const matrix = Matrix4.mirrorPlane(normalizedPlane.normal, normalizedPlane.origin);
      const mirrorFeature = new MirrorFeature(planeObj, matrix);
      const mirrorTree = cloneWithTransform(targetObjects, matrix, mirrorFeature);

      context.addSceneObject(mirrorFeature);
      context.addSceneObjects(mirrorTree);
      return mirrorFeature;
    }

    if (type === 'rotate') {
      const axisArg = args[1];
      const axis = axisArg instanceof AxisObjectBase
        ? axisArg.getAxis()
        : normalizeAxis(axisArg as AxisLike);
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

      const matrix = Matrix4.fromRotationAroundAxis(axis.origin, axis.direction, rad(angle));
      const feature = new RepeatMatrix(matrix, objects);
      const cloned = cloneWithTransform(objects, matrix, feature);

      context.addSceneObject(feature);
      context.addSceneObjects(cloned);
      return feature;
    }

    throw new Error(`Invalid repeat type: ${type}`);
  }) as RepeatFunction;
}

export default registerBuilder(build);
