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
import { CopyPattern } from "../features/copy-pattern.js";
import { BoundConnector, Connector } from "../features/connector.js";
import { ConnectorAxis } from "../features/connector-axis.js";
import { ConnectorCopyRules, ConnectorCopyScope } from "../features/connector-copy.js";
import { Sketch } from "../features/2d/sketch.js";
import { Axis } from "../math/axis.js";
import { resolveAxis } from "../helpers/resolve.js";
import { AssemblyScene } from "../rendering/assembly-scene.js";
import { Scene } from "../rendering/scene.js";
import { IConnector, ICopy, IRepeat, ISceneObject } from "./interfaces.js";

export type CopyType = 'linear' | 'circular';

/**
 * Where the statement runs: a part body (the part and the container around
 * the call), or — outside any part in an *.assembly.js file — the assembly's
 * top level, under the scope path it ran in.
 */
function copyScope(scene: Scene): ConnectorCopyScope {
  if (scene instanceof AssemblyScene && !scene.getActivePart()) {
    return { kind: 'assembly', scopePath: scene.currentScopePath() };
  }
  return { kind: 'part', part: scene.getActivePart(), container: scene.getActiveContainer() };
}

/**
 * Add a 3D copy, then the connector copies it makes: registered right after
 * it and parented under it, so they build after their seeds. `refusal`
 * refuses the statement outright (an inserted instance's connector among
 * the targets, or a top-level assembly copy breaking its rules). At an
 * assembly's top level each copy also joins the assembly's connectors, so
 * it serializes, draws and mates like the connector it copies.
 */
function addCopy<T extends CopyBase>(
  context: SceneParserContext,
  copy: T,
  scope: ConnectorCopyScope,
  refusal: string | null,
): T {
  context.addSceneObject(copy);
  if (refusal) {
    copy.refuse(refusal);
    return copy;
  }
  const copies = copy.copyConnectors(scope);
  context.addSceneObjects(copies);
  const scene = getCurrentScene();
  if (scope.kind === 'assembly' && scene instanceof AssemblyScene) {
    for (const connectorCopy of copies) {
      scene.registerAssemblyConnector(connectorCopy);
    }
  }
  return copy;
}

/**
 * Add the follow form, `copy(pattern, ...connectors)`: copies of connectors
 * laid on a linear or circular repeat's own instances. Only scene objects
 * join the statement's targets — an inserted instance's connector refuses it
 * and stays out, as it does for the other forms — and every rule the form
 * adds refuses the statement on its own row ({@link
 * CopyPattern.statementRefusal}); the connectors' own rules follow when its
 * copies are made.
 */
function addPatternCopy(
  context: SceneParserContext,
  pattern: unknown,
  targets: unknown[],
  scope: ConnectorCopyScope,
): CopyPattern {
  const refusal = CopyPattern.statementRefusal(pattern, targets, scope, context.getActiveSketch() !== null);
  const copy = new CopyPattern(
    pattern instanceof SceneObject ? pattern : null,
    targets.filter((target): target is SceneObject => target instanceof SceneObject),
  );
  return addCopy(context, copy, scope, refusal);
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
 * concrete Axis values with no extra scene object. A connector stands for
 * its Z axis through its origin, read off its frame at build time; an
 * inserted instance's connector refuses the statement ({@link
 * ConnectorCopyRules.boundAxis}) and is carried as its part connector only
 * so the statement still has an axis to hold. At an assembly's top level a
 * scene object that is no connector refuses the statement too ({@link
 * ConnectorCopyRules.assemblyAxis}): it is never resolved — that would add
 * its scene objects to the assembly — and the world Z axis stands in, never
 * read by a statement that never builds.
 */
function resolveCopyAxis(arg: unknown, context: SceneParserContext, scope: ConnectorCopyScope): CopyAxisSource {
  if (arg instanceof AxisObjectBase) {
    return arg;
  }
  if (arg instanceof Connector) {
    return new ConnectorAxis(arg);
  }
  if (arg instanceof BoundConnector) {
    return new ConnectorAxis(arg.connector);
  }
  if (arg instanceof SceneObject) {
    if (scope.kind === 'assembly') {
      return normalizeAxis('z');
    }
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
   * `IConnector.instance`), made inside the connector's own part body. At an
   * assembly file's top level it copies assembly connectors only:
   * `copy('linear', 'x', { count: 4, offset: 50 }, bay)` makes
   * `bay.instance(1)` … `bay.instance(3)`, the axis a world axis or an
   * assembly connector.
   * @param type - Must be `'linear'`
   * @param axis - The axis to copy along — a world axis, an `axis()`, an edge, or a connector (its Z axis)
   * @param options - Copy count, spacing, etc.
   * @param objects - The objects to copy (defaults to last object)
   */
  (type: 'linear', axis: AxisLike | IConnector, options: LinearCopyOptions, ...objects: ISceneObject[]): ICopy;
  /**
   * [3D] Creates linear copies along multiple axes. A connector among the
   * objects is copied as a frame, one copy per grid cell — see
   * `IConnector.instance` for the numbering.
   * @param type - Must be `'linear'`
   * @param axis - The axes to copy along — each a world axis, an `axis()`, an edge, or a connector (its Z axis)
   * @param options - Copy count, spacing, etc.
   * @param objects - The objects to copy (defaults to last object)
   */
  (type: 'linear', axis: (AxisLike | IConnector)[], options: LinearCopyOptions, ...objects: ISceneObject[]): ICopy;

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
   * 360 }, bolt)` makes `bolt.instance(1)` … `bolt.instance(5)`. At an
   * assembly file's top level it copies assembly connectors only, around a
   * world axis or an assembly connector's Z axis.
   * @param type - Must be `'circular'`
   * @param axis - The axis to copy around — a world axis, an `axis()`, an edge, or a connector (its Z axis through its origin)
   * @param options - Copy count, angle, etc.
   * @param objects - The objects to copy (defaults to last object)
   */
  (type: 'circular', axis: AxisLike | IConnector, options: CircularCopyOptions, ...objects: ISceneObject[]): ICopy;

  /**
   * [3D] Copies connectors onto the instances of a linear or circular
   * `repeat()`: each copy is the connector's frame moved the way the repeat
   * moved that instance, so `copy(holes, bolt)` puts `bolt.instance(k)` on
   * `holes.instance(k)` — the repeat's own slots, skipped ones included, and
   * a partial arc spaced the repeat's way. Edit the repeat and the copies
   * follow. Connectors only, inside the part body that declares both the
   * repeat and the connectors; a mirror, rotate or matrix repeat is refused.
   * @param pattern - The linear or circular `repeat()` to follow
   * @param connectors - The connectors to copy
   */
  (pattern: IRepeat, ...connectors: IConnector[]): ICopy;
}

function build(context: SceneParserContext): CopyFunction {
  return function copy() {
    const args = Array.from(arguments);

    if (args.length === 0) {
      throw new Error("Invalid arguments for copy function: expected (type, axis, options, …objects) or (pattern, …connectors)");
    }

    const scope = copyScope(getCurrentScene());
    // The follow form: a repeat() where the copy type goes.
    if (typeof args[0] !== 'string') {
      return addPatternCopy(context, args[0], args.slice(1), scope);
    }

    if (args.length < 3) {
      throw new Error("Invalid arguments for copy function: expected at least (type, axis, options)");
    }

    const type = args[0] as CopyType;
    const activeSketch = context.getActiveSketch();
    const options = args[2] as LinearCopyOptions | CircularCopyOptions;
    const restObjects = args.slice(3) as unknown[];
    // An inserted instance's connector refuses the statement, as a target or
    // as the axis; it is no scene object, so it stays out of the targets the
    // statement compares and builds. Explicit targets stay explicit even when
    // that leaves none: only a copy() written without targets copies
    // everything before it. At an assembly's top level the statement's own
    // rules come first — root scope, assembly connectors as its targets, a
    // world axis or an assembly connector as its axis — and a value that is
    // no scene object never joins its targets either.
    const axisArgs = Array.isArray(args[1]) ? args[1] as unknown[] : [args[1]];
    const assemblyRefusal = scope.kind === 'assembly'
      ? ConnectorCopyRules.assemblyStatement(restObjects, scope.scopePath) ?? ConnectorCopyRules.assemblyAxis(axisArgs)
      : null;
    const boundRefusal = assemblyRefusal
      ?? ConnectorCopyRules.boundTarget(restObjects)
      ?? ConnectorCopyRules.boundAxis(axisArgs);
    const explicit = scope.kind === 'assembly'
      ? restObjects.filter((t): t is SceneObject => t instanceof SceneObject)
      : restObjects.filter(t => !(t instanceof BoundConnector)) as SceneObject[];
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

      const axes = axisList.map(a => resolveCopyAxis(a, context, scope));
      return addCopy(context, new CopyLinear(axes, options as LinearCopyOptions, objects), scope, boundRefusal);
    }

    if (type === 'circular') {
      if (activeSketch) {
        const center = normalizePoint2D(args[1] as Point2DLike);
        const copy = new CopyCircular2D(center, options as CircularCopyOptions, objects);
        return addSketchCopy(context, copy, activeSketch, boundRefusal ?? ConnectorCopyRules.inSketch(explicit));
      }

      const axis = resolveCopyAxis(args[1], context, scope);
      return addCopy(context, new CopyCircular(axis, options as CircularCopyOptions, objects), scope, boundRefusal);
    }

    throw new Error(`Invalid copy type: ${type}`);
  } as CopyFunction;
}

// Allowed at an assembly's top level too: there it copies the assembly's
// own connectors (`copy('linear', 'x', { … }, bay)`), under its own rules.
export default registerBuilder(build, { allowAssemblyTopLevel: true });
