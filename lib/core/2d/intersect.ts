import { SceneObject } from "../../common/scene-object.js";
import { Intersect } from "../../features/2d/intersect.js";
import { IntersectionCurve } from "../../features/intersection-curve.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { IIntersectionCurve, IReference, ISceneObject } from "../interfaces.js";
import { OperandArguments, type OperandCall } from "../operand-arguments.js";

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

/** `intersect(first, second)` outside a sketch: two arguments of faces, and the words of its refusals. */
const INTERSECT_CALL: OperandCall<'first' | 'second'> = {
  callee: 'intersect',
  arguments: {
    first: { takes: 'faces, a surface or a solid,', wants: 'the faces to intersect' },
    second: { takes: 'faces, a surface or a solid,', wants: 'the faces to intersect' },
  },
  missing: "intersect: outside a sketch, give the two sets of faces to intersect: intersect(first, second).",
  tooMany: count => `intersect: outside a sketch, intersect takes two arguments, got ${count}: put several objects on one side in a list, as in intersect([a, b], c).`,
};

/**
 * The two sides of `intersect(first, second)` outside a sketch, each a list
 * of scene objects: one object, or the objects of a list. Fewer or more
 * than two arguments, an empty list, or an argument that is not a scene
 * object is refused.
 */
export function partIntersectArgs(args: readonly unknown[]): [SceneObject[], SceneObject[]] {
  const { first, second } = OperandArguments.read(args, INTERSECT_CALL);
  return [first, second];
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
    return OperandArguments.addTool(context, [...first, ...second], () => new IntersectionCurve(first, second));
  } as IntersectFunction;
}

export default registerBuilder(build);
