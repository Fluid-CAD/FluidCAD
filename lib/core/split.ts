import { registerBuilder, SceneParserContext } from "../index.js";
import { SceneObject } from "../common/scene-object.js";
import { isPlaneLike, PlaneLike } from "../math/plane.js";
import { PlaneObjectBase } from "../features/plane-renderable-base.js";
import { GeometrySceneObject } from "../features/2d/geometry.js";
import { PlaneFromSketchLine } from "../features/plane-from-sketch-line.js";
import { resolvePlane } from "../helpers/resolve.js";
import { materializePartArgs } from "../features/part-args.js";
import { Split, SPLIT_KEEP_VALUES } from "../features/split.js";
import type { SplitOptions } from "../features/split.js";
import { IGeometry, IPlane, ISceneObject, ISplit } from "./interfaces.js";

export type { SplitOptions, SplitKeep, SplitSide } from "../features/split.js";

interface SplitFunction {
  /**
   * Splits solids with a plane: every solid the plane crosses becomes the
   * pieces on either side, each a body of its own with a flat cap on the
   * plane. Without targets every solid in scope is a candidate; a solid the
   * plane misses is left as it is.
   *
   *     split('xz');                                   // every body, at the XZ plane
   *     split(p, boss);                                // one body, at a plane() statement
   *     split(select(face().onPlane('xy', 30)));       // at a planar face
   *     split('yz', { keep: 'front' }, body);          // keep the normal side only
   *     split('xy', { offset: 12 });                   // 12 above XY
   *
   * `keep` drops the pieces on one side — `front` is the side the plane
   * normal points to. `offset` moves the plane along its normal first.
   *
   * @param plane - An origin plane (`'xy'`, `'xz'`, `'yz'`), a `plane()` statement, or a planar face selection.
   * @param targets - The solids to split; none for every solid in scope.
   */
  (plane: PlaneLike | IPlane | ISceneObject, ...targets: ISceneObject[]): ISplit;
  /**
   * Splits solids with a plane, with options.
   * @param plane - An origin plane (`'xy'`, `'xz'`, `'yz'`), a `plane()` statement, or a planar face selection.
   * @param options - `keep` (`'both'`, `'front'`, `'back'`) and `offset` along the normal.
   * @param targets - The solids to split; none for every solid in scope.
   */
  (plane: PlaneLike | IPlane | ISceneObject, options: SplitOptions, ...targets: ISceneObject[]): ISplit;
  /**
   * Splits solids along a sketched line: the line seeds the infinite plane
   * that contains it and stands normal to its sketch, as if the line were
   * extruded out of the sketch both ways. The sketch is consumed for display
   * like an extrude's profile (the timeline eye shows it again); the line
   * stays readable, so a construction line is the usual seed.
   *
   *     let seed;
   *     sketch('xy', () => { seed = line([0, -50], [0, 50]).guide(); … });
   *     extrude(20);
   *     split(seed);                                   // at the plane the line sweeps
   *
   * @param line - A `line()` of a sketch.
   * @param targets - The solids to split; none for every solid in scope.
   */
  (line: IGeometry, ...targets: ISceneObject[]): ISplit;
  /**
   * Splits solids along a sketched line, with options.
   * @param line - A `line()` of a sketch.
   * @param options - `keep` (`'both'`, `'front'`, `'back'`) and `offset` along the plane normal (line direction × sketch normal).
   * @param targets - The solids to split; none for every solid in scope.
   */
  (line: IGeometry, options: SplitOptions, ...targets: ISceneObject[]): ISplit;
}

function isOptionsBag(value: unknown): value is SplitOptions {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof SceneObject);
}

function validateOptions(options: unknown): SplitOptions {
  if (options === undefined) {
    return {};
  }
  if (!isOptionsBag(options)) {
    throw new Error(`split(): the options are an object { keep?, offset? } (got ${options === null ? 'null' : typeof options}).`);
  }
  const { keep, offset } = options as SplitOptions;
  if (keep !== undefined && !SPLIT_KEEP_VALUES.includes(keep)) {
    throw new Error(`split(): keep must be 'both', 'front' or 'back' (got ${JSON.stringify(keep)}).`);
  }
  if (offset !== undefined && (typeof offset !== 'number' || !Number.isFinite(offset))) {
    throw new Error(`split(): offset must be a finite number (got ${JSON.stringify(offset)}).`);
  }
  for (const key of Object.keys(options)) {
    if (key !== 'keep' && key !== 'offset') {
      throw new Error(`split(): unknown option '${key}' — the options are { keep?, offset? }.`);
    }
  }
  return {
    ...(keep !== undefined ? { keep } : {}),
    ...(offset !== undefined ? { offset } : {}),
  };
}

/**
 * The cut plane a split's first argument names. A sketched line seeds the
 * plane it would sweep out of its sketch; anything else is a plane the
 * same way `mirror(plane, …)` reads one.
 */
function resolveCutter(arg: unknown, context: SceneParserContext): PlaneObjectBase {
  if (arg instanceof GeometrySceneObject) {
    const planeObj = new PlaneFromSketchLine(arg);
    planeObj.markInternal();
    context.addSceneObject(planeObj);
    return planeObj;
  }
  const valid = arg instanceof PlaneObjectBase || isPlaneLike(arg) || arg instanceof SceneObject;
  if (!valid) {
    throw new Error(
      "split(): the first argument is the cut — 'xy', 'xz', 'yz', a plane() statement, a planar face selection, or a sketched line.",
    );
  }
  return resolvePlane(arg as PlaneLike | ISceneObject, context);
}

function build(context: SceneParserContext): SplitFunction {
  return function split(...args: unknown[]): ISplit {
    if (context.getActiveSketch()) {
      throw new Error("split() is a 3D operation and cannot be used inside a sketch. Close the sketch first, then split the solid.");
    }
    if (args.length === 0) {
      throw new Error("split() takes the cut first — a plane ('xy', a plane() statement, a planar face) or a sketched line.");
    }

    const cutter = resolveCutter(args[0], context);

    let options: SplitOptions = {};
    let rest = args.slice(1);
    if (rest.length > 0 && isOptionsBag(rest[0])) {
      options = validateOptions(rest[0]);
      rest = rest.slice(1);
    }

    const targets = materializePartArgs(rest) as unknown[];
    for (let i = 0; i < targets.length; i++) {
      if (!(targets[i] instanceof SceneObject)) {
        throw new Error(`split(): target ${i + 1} is not a feature (got ${typeof targets[i]}).`);
      }
    }

    const feature = new Split(cutter, targets.length > 0 ? targets as SceneObject[] : null, options);
    context.addSceneObject(feature);
    return feature;
  } as SplitFunction;
}

export default registerBuilder<SplitFunction>(build);
