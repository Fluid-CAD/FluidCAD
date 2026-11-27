import { SceneObject } from "../../common/scene-object.js";
import { Intersect } from "../../features/2d/intersect.js";
import { IntersectionCurve } from "../../features/intersection-curve.js";
import { SelectSceneObject } from "../../features/select.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { IIntersectionCurve, IReference, ISceneObject } from "../interfaces.js";

interface IntersectFunction {
  /**
   * [3D] The curve where two sets of faces meet, written outside a sketch.
   * The result holds one wire per connected chain of intersection edges, in
   * an order that does not change between rebuilds: `edges()`, `start()`
   * and `end()` read it. The faces are read, not used up.
   *
   * Faces that only touch — along an edge, tangentially, or lying on each
   * other — have no intersection curve.
   * @param first - Faces: a face selection (of solids or surfaces), a surface, a solid (all its faces), or a list of those.
   * @param second - Faces, as `first` takes them, or a `plane()`, taken as infinite.
   */
  (first: ISceneObject | ISceneObject[], second: ISceneObject | ISceneObject[]): IIntersectionCurve;

  /**
   * [2D] Intersects 3D objects with the current sketch plane, producing cross-section edges.
   * @param sourceObjects - The 3D objects to intersect
   */
  (...sourceObjects: ISceneObject[]): IReference;
}

/** The refusal of a call outside a sketch that does not name two sides. */
const TWO_SIDES = "intersect: outside a sketch, give the two sets of faces to intersect: intersect(first, second).";

/**
 * The two sides of `intersect(first, second)` outside a sketch, each a list
 * of scene objects: one object, or the objects of a list. Fewer or more
 * than two arguments, an empty list, or an argument that is not a scene
 * object is refused.
 */
export function partIntersectArgs(args: readonly unknown[]): [SceneObject[], SceneObject[]] {
  if (args.length < 2) {
    throw new Error(TWO_SIDES);
  }
  if (args.length > 2) {
    throw new Error(
      `intersect: outside a sketch, intersect takes two arguments, got ${args.length}: put several objects on one side in a list, as in intersect([a, b], c).`,
    );
  }
  return [operandList(args[0], 'first'), operandList(args[1], 'second')];
}

function operandList(arg: unknown, side: 'first' | 'second'): SceneObject[] {
  const list = Array.isArray(arg) ? arg : [arg];
  if (list.length === 0) {
    throw new Error(`intersect: the ${side} argument is an empty list; give it the faces to intersect.`);
  }
  for (const item of list) {
    if (!(item instanceof SceneObject)) {
      throw new Error(
        `intersect: the ${side} argument must be faces, a surface or a solid, or a list of them; got ${describe(item)}.`,
      );
    }
  }
  return list as SceneObject[];
}

function describe(value: unknown): string {
  if (value === null || value === undefined) {
    return String(value);
  }
  if (typeof value === 'string') {
    return `'${value}'`;
  }
  return Array.isArray(value) ? 'a nested list' : typeof value === 'object' ? 'an object' : String(value);
}

/** Inside a sketch: the sketch tool, sectioning its arguments with the sketch plane. */
function sketchIntersect(context: SceneParserContext, args: any[]): IReference {
  const result = new Intersect(args as SceneObject[]);
  context.addSceneObjects(args);
  context.addSceneObject(result);
  return result;
}

function build(context: SceneParserContext): IntersectFunction {
  return function intersect(...args: any[]) {
    if (context.getActiveSketch()) {
      return sketchIntersect(context, args);
    }
    const [first, second] = partIntersectArgs(args);
    context.addSceneObjects([...first, ...second]);
    const result = new IntersectionCurve(first, second);
    context.addSceneObject(result);
    // registerBuilder claims the selections passed bare; those inside a
    // list are claimed here, with the statement's own location.
    SelectSceneObject.claimOperands([...first, ...second], result.getSourceLocation());
    return result;
  } as IntersectFunction;
}

export default registerBuilder(build);
