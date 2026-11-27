import { SceneObject } from "../../common/scene-object.js";
import { Offset } from "../../features/2d/offset.js";
import { OffsetCurve } from "../../features/offset-curve.js";
import { EdgeTargetArg } from "../../features/2d/geometry.js";
import { Sketch } from "../../features/2d/sketch.js";
import { EdgeFilterBuilder } from "../../filters/edge/edge-filter.js";
import { FilterBuilderBase } from "../../filters/filter-builder-base.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { IOffset, IOffsetCurve, ISceneObject } from "../interfaces.js";
import { OperandArguments, type OperandArgument } from "../operand-arguments.js";
import { type NumberParam, isNumberParam, isBooleanParam, resolveParam } from "../param.js";
import { addTargetObjects, sketchLastSelection } from "../target-utils.js";

interface OffsetFunction {
  /**
   * [3D] Offsets curves along faces, written outside a sketch: a curve
   * beside `edges` at `distance`, measured straight through space, lying on
   * the faces given in `{ on }` — a line set back from an edge of a body, the
   * inner boundary of a band along a rim, a curve beside a projected curve.
   *
   * The sign picks the side. Walking along the edges standing on the
   * outside of the faces, a positive distance goes to the left, a negative
   * one to the right. Edges along the rim of the faces — one face beside
   * each — are walked the way that face's boundary runs, so a positive
   * distance goes onto the faces.
   *
   * The result holds one wire per chain of the edges, each running the same
   * way as its source, in source order: `edges()`, `start()` and `end()`
   * read it. A sketch or a curve given as the edges is hidden and stays
   * readable; the faces are read, not used up.
   * @param distance - The distance, not zero: positive for the left side, negative for the right.
   * @param edges - Curves: a selection of edges, a curve object, a sketch, or a list of those. They must lie on the faces.
   * @param options - `{ on }`: the faces the curve lies on — a face selection, a surface, a solid, or a list of those.
   */
  (distance: NumberParam, edges: ISceneObject | ISceneObject[], options: { on: ISceneObject | ISceneObject[] }): IOffsetCurve;

  /**
   * Offsets sketch geometry by the given distance. With no targets, offsets
   * the whole sketch (or the last `select(...)` result if one precedes it).
   *
   * Outside a sketch, targets may be one or more coplanar faces (a
   * `select(face()...)` result or a solid op's face accessor like
   * `body.endFaces()`); with no targets the preceding `select(...)` is used.
   * The offset outlines are created on the face plane — a positive distance
   * offsets outward and shrinks holes — and the result is extrudable like
   * any sketch. Outside a sketch with a trailing `{ on: faces }`,
   * `offset(distance, edges, { on: faces })` is the offset curve instead: a
   * curve beside the edges, lying on the faces.
   * @param distance - The offset distance (defaults to 1)
   * @param targets - Optional geometries, edge accessors (`r.edge('top')`),
   *   edge filters (`edge().arc()`), or (outside a sketch) coplanar face
   *   selections to offset instead of the whole sketch
   */
  (distance?: NumberParam, ...targets: (ISceneObject | EdgeFilterBuilder)[]): IOffset;
}

/** The edges argument of `offset(distance, edges, { on: faces })`, as its refusals name it. */
const OFFSET_CURVE_EDGES: OperandArgument & { callee: string; name: string } = {
  callee: 'offset',
  name: 'edges',
  takes: 'curves — a selection of edges, a curve, a sketch —',
  wants: 'the curves to offset',
};

/**
 * Whether a value is a plain object, `{ on: faces }`: an object literal — not
 * a scene object, a list, a filter or a parameter, which are all instances
 * of classes.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  // `Object.prototype` (of any realm: its own prototype is null), or none.
  return prototype === null || Object.getPrototypeOf(prototype) === null;
}

/**
 * The options object of an `offset` written outside a sketch: its trailing
 * argument when that is a plain object, else null. Its presence is what
 * makes the statement an offset curve.
 */
export function partOffsetOptions(args: readonly unknown[]): Record<string, unknown> | null {
  const last = args[args.length - 1];
  return isPlainObject(last) ? last : null;
}

/**
 * The arguments of `offset(distance, edges, { on: faces })` outside a
 * sketch: the distance (a number or a parameter, read now), the edges and
 * the faces, each one scene object or a non-empty list. An options object
 * with any key but `on`, or without it, a distance that is not a number, a
 * count other than three, an empty list or an item that is not a scene
 * object is refused. A zero distance is the curve's own refusal, when it
 * builds.
 */
export function partOffsetCurveArgs(args: readonly unknown[]): { distance: number; edges: SceneObject[]; on: SceneObject[] } {
  const options = partOffsetOptions(args);
  const keys = options ? Object.keys(options) : [];
  if (!options || keys.length !== 1 || keys[0] !== 'on') {
    throw new Error("offset: the only option is { on: faces }.");
  }
  if (args.length < 3) {
    throw new Error("offset: an offset curve needs a distance and the edges before { on }: offset(distance, edges, { on: faces }).");
  }
  if (args.length > 3) {
    throw new Error(`offset: an offset curve takes one edges argument, got ${args.length - 2}: put several objects in one list, as in offset(2, [a, b], { on: faces }).`);
  }
  const [distance, edges] = args;
  if (!isNumberParam(distance)) {
    throw new Error(`offset: the distance must be a number; got ${OperandArguments.describe(distance)}.`);
  }
  const listed = OperandArguments.list(edges, OFFSET_CURVE_EDGES);
  const on: unknown[] = Array.isArray(options.on) ? options.on : [options.on];
  if (on.length === 0 || on.some(item => !(item instanceof SceneObject))) {
    throw new Error("offset: { on } needs the faces the curve lies on.");
  }
  return { distance: resolveParam(distance), edges: listed, on: on as SceneObject[] };
}

/** The distance an offset's first argument gives (1 when it is left out), and the removeOriginal flag it no longer takes. */
function offsetDistance(args: unknown[]): number {
  const distance = isNumberParam(args[0]) ? resolveParam(args[0] as NumberParam) : 1;
  if (args.some(a => isBooleanParam(a))) {
    throw new Error("offset() no longer takes a removeOriginal flag — mark the sources .guide() instead");
  }
  return distance;
}

/** The arguments an offset outline takes as targets: scene objects and edge filters. */
function outlineTargets(args: unknown[]): EdgeTargetArg[] {
  return args.filter(
    (a): a is EdgeTargetArg => a instanceof SceneObject || a instanceof FilterBuilderBase,
  );
}

/** Adds the outline offset of `targets` (null when there are none) after them. */
function addOutline(context: SceneParserContext, distance: number, targets: EdgeTargetArg[]): Offset {
  addTargetObjects(targets, context);
  const off = new Offset(distance, targets.length > 0 ? targets : null);
  context.addSceneObject(off);
  return off;
}

/** Inside a sketch: the sketch tool, offsetting its targets or, given none, the whole sketch or its last selection. */
function sketchOffset(context: SceneParserContext, args: unknown[], activeSketch: Sketch): Offset {
  const distance = offsetDistance(args);
  let targets = outlineTargets(args);
  if (targets.length === 0) {
    targets = sketchLastSelection(context, activeSketch);
  }
  return addOutline(context, distance, targets);
}

/**
 * Outside a sketch without `{ on }`: the outline of coplanar faces offset on
 * their plane, as extrudable edges. Given no targets, a preceding
 * `select(face()...)` is the target, as the 3D operations take it.
 */
function legacyFaceOffset(context: SceneParserContext, args: unknown[]): Offset {
  const distance = offsetDistance(args);
  let targets = outlineTargets(args);
  if (targets.length === 0) {
    const lastSelection = context.getLastSelection();
    if (lastSelection) {
      targets = [lastSelection];
    }
  }
  return addOutline(context, distance, targets);
}

function build(context: SceneParserContext): OffsetFunction {
  return function offset(...args: any[]) {
    const activeSketch = context.getActiveSketch();
    if (activeSketch) {
      return sketchOffset(context, args, activeSketch);
    }
    if (partOffsetOptions(args)) {
      const { distance, edges, on } = partOffsetCurveArgs(args);
      return OperandArguments.addTool(context, [...edges, ...on], () => new OffsetCurve(distance, edges, on));
    }
    return legacyFaceOffset(context, args);
  } as OffsetFunction;
}

export default registerBuilder(build);
