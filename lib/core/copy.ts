import { registerBuilder, SceneParserContext } from "../index.js";
import { getCurrentScene } from "../scene-manager.js";
import { normalizeAxis, normalizePoint2D } from "../helpers/normalize.js";
import { AxisLike } from "../math/axis.js";
import { Point2DLike } from "../math/point.js";
import { SceneObject } from "../common/scene-object.js";
import { CopyLinear, LinearCopyOptions } from "../features/copy-linear.js";
import { CopyCircular, CircularCopyOptions } from "../features/copy-circular.js";
import { CopyLinear2D, CopyLinear2DAxis } from "../features/copy-linear2d.js";
import { CopyCircular2D } from "../features/copy-circular2d.js";
import { SketchDatum } from "../features/2d/solved/datum.js";
import { AxisObjectBase } from "../features/axis-renderable-base.js";
import { CopyAxisSource, CopyBase } from "../features/copy-base.js";
import { BoundConnector } from "../features/connector.js";
import { ConnectorCopyRules } from "../features/connector-copy.js";
import { Sketch } from "../features/2d/sketch.js";
import { Axis } from "../math/axis.js";
import { resolveAxis } from "../helpers/resolve.js";
import { ICopy, ISceneObject } from "./interfaces.js";

export type CopyType = 'linear' | 'circular';

/**
 * Add a 3D copy, then the connector copies it makes: registered right after
 * it and parented under it, so they build after their seeds. `refusal`
 * refuses the statement outright (an inserted instance's connector among
 * the targets).
 */
function addCopy<T extends CopyBase>(context: SceneParserContext, copy: T, refusal: string | null): T {
  context.addSceneObject(copy);
  if (refusal) {
    copy.refuse(refusal);
    return copy;
  }
  const scene = getCurrentScene();
  context.addSceneObjects(copy.copyConnectors({
    part: scene.getActivePart(),
    container: scene.getActiveContainer(),
  }));
  return copy;
}

/**
 * Add a 2D copy. A refused one — a connector among its targets, which a
 * sketch never copies — registers no solver duplicates: it never builds.
 */
function addSketchCopy<T extends CopyLinear2D | CopyCircular2D>(
  context: SceneParserContext,
  copy: T,
  sketch: Sketch,
  refusal: string | null,
): T {
  context.addSceneObject(copy);
  if (refusal) {
    copy.refuse(refusal);
    return copy;
  }
  // Statement time, before any constraint can name an instance —
  // solver-backed sources get tied duplicate entities per slot.
  copy.registerSolverDuplicates(sketch);
  return copy;
}

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
   * @param axis - The axis to copy along — `xAxis()` / `yAxis()` for the sketch's own axes, a sketched line via `axis(l)`; a bare `'x'` is the WORLD axis
   * @param options - Copy count, spacing, etc.
   * @param objects - The objects to copy (defaults to last object)
   */
  (type: 'linear', axis: AxisLike, options: LinearCopyOptions, ...objects: ISceneObject[]): ICopy;
  /**
   * [2D] Creates linear copies along multiple axes inside a sketch.
   * @param type - Must be `'linear'`
   * @param axis - The axes to copy along — `xAxis()` / `yAxis()` for the sketch's own axes, a sketched line via `axis(l)`; a bare `'x'` is the WORLD axis
   * @param options - Copy count, spacing, etc.
   * @param objects - The objects to copy (defaults to last object)
   */
  (type: 'linear', axis: AxisLike[], options: LinearCopyOptions, ...objects: ISceneObject[]): ICopy;

  /**
   * [3D] Creates linear copies along an axis. A connector among the objects
   * is copied as a frame: its copies are `bolt.instance(1)`, … (see
   * `IConnector.instance`), made inside the connector's own part body.
   * @param type - Must be `'linear'`
   * @param axis - The axis to copy along
   * @param options - Copy count, spacing, etc.
   * @param objects - The objects to copy (defaults to last object)
   */
  (type: 'linear', axis: AxisLike, options: LinearCopyOptions, ...objects: ISceneObject[]): ICopy;
  /**
   * [3D] Creates linear copies along multiple axes. A connector among the
   * objects is copied as a frame, one copy per grid cell — see
   * `IConnector.instance` for the numbering.
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
   * [3D] Creates circular copies around an axis. A connector among the
   * objects is copied as a frame: `copy('circular', 'z', { count: 6, angle:
   * 360 }, bolt)` makes `bolt.instance(1)` … `bolt.instance(5)`.
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
    const restObjects = args.slice(3) as unknown[];
    // An inserted instance's connector refuses the statement; it is no scene
    // object, so it stays out of the targets the statement compares and
    // builds. Explicit targets stay explicit even when that leaves none:
    // only a copy() written without targets copies everything before it.
    const boundRefusal = ConnectorCopyRules.boundTarget(restObjects);
    const explicit = restObjects.filter(t => !(t instanceof BoundConnector)) as SceneObject[];
    const objects = restObjects.length > 0
      ? explicit
      : null;

    if (type === 'linear') {
      const axisArg = args[1] as AxisLike | AxisLike[];
      const axisList = Array.isArray(axisArg) ? axisArg : [axisArg];

      if (activeSketch) {
        const sketchAxes: CopyLinear2DAxis[] = axisList.map(a => {
          if (a instanceof AxisObjectBase) {
            return a;
          }
          if (a instanceof SketchDatum) {
            // xAxis()/yAxis(): the sketch plane's own axis, promoted on demand.
            const axis = a.toAxisObject('copy', activeSketch);
            context.addSceneObject(axis);
            return axis;
          }
          return normalizeAxis(a);
        });
        const copy = new CopyLinear2D(sketchAxes, options as LinearCopyOptions, objects);
        return addSketchCopy(context, copy, activeSketch, boundRefusal ?? ConnectorCopyRules.inSketch(explicit));
      }

      const axes = axisList.map(a => resolveCopyAxis(a, context));
      return addCopy(context, new CopyLinear(axes, options as LinearCopyOptions, objects), boundRefusal);
    }

    if (type === 'circular') {
      if (activeSketch) {
        const center = normalizePoint2D(args[1] as Point2DLike);
        const copy = new CopyCircular2D(center, options as CircularCopyOptions, objects);
        return addSketchCopy(context, copy, activeSketch, boundRefusal ?? ConnectorCopyRules.inSketch(explicit));
      }

      const axis = resolveCopyAxis(args[1], context);
      return addCopy(context, new CopyCircular(axis, options as CircularCopyOptions, objects), boundRefusal);
    }

    throw new Error(`Invalid copy type: ${type}`);
  } as CopyFunction;
}

export default registerBuilder(build);
