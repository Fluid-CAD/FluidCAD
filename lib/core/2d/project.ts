import { SceneObject } from "../../common/scene-object.js";
import { Projection } from "../../features/2d/projection.js";
import { ProjectedCurve } from "../../features/projected-curve.js";
import { DirectionInput } from "../../helpers/direction-input.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { IProjectedCurve, IReference, ISceneObject } from "../interfaces.js";
import { OperandArguments, type OperandCall } from "../operand-arguments.js";

interface ProjectFunction {
  /**
   * [3D] Throws curves onto faces, written outside a sketch: every point of
   * the source travels along one line (the default, set by `.direction()`;
   * left out, the normal of the plane the source lies in) or, with
   * `.mode('normal')`, to the closest point of the target. The line is a
   * line, not an arrow: the source is projected both ways along it, and
   * `.keep()` decides which images stay — what each point meets first (the
   * default; in mode `'normal'`, the nearest image) or, with
   * `.keep('all')`, every one.
   *
   * The result holds one wire per image chain, each running the same way as
   * its source, images in source order: `edges()`, `start()` and `end()`
   * read it. The source curves are hidden and stay readable; the target is
   * read, not used up.
   * @param source - Curves: a sketch, a sketch statement, a curve object, a selection of edges, or a list of those.
   * @param target - Faces: a face selection (of solids or surfaces), a surface, a solid (all its faces), or a list of those.
   */
  (source: ISceneObject | ISceneObject[], target: ISceneObject | ISceneObject[]): IProjectedCurve;

  /**
   * [2D] Projects 3D objects — faces, edges, selections — or previous sketches
   * onto the current sketch plane. The output registers as FIXED reference
   * geometry — constraints may target it (`tangent(p, l)`, `p.ref(i)`,
   * `p.center()`).
   *
   * A sketch source (`project(s1)`, or an entity it returned such as
   * `project(s1.geometries.c)`) is referenced, never consumed: its geometry
   * is read as its own body left it, so the reference works whether or not
   * an extrude has already used the sketch, and the sketch stays available
   * to later features. A sketch cannot project its own geometry.
   * @param sourceObjects - The 3D objects or sketches to project
   */
  (...sourceObjects: ISceneObject[]): IReference;
}

/** `project(source, target)` outside a sketch: curves and the faces they land on, and the words of its refusals. */
const PROJECT_CALL: OperandCall<'source' | 'target'> = {
  callee: 'project',
  arguments: {
    source: { takes: 'curves — a sketch, a curve, a selection of edges —', wants: 'the curves to project' },
    target: { takes: 'faces, a surface or a solid,', wants: 'the faces to project onto' },
  },
  missing: "project: outside a sketch, give the curves to project and the faces to project them onto: project(source, target).",
  tooMany: count => `project: outside a sketch, project takes two arguments, got ${count}: put several objects in one argument as a list, as in project([a, b], faces).`,
};

/**
 * The two arguments of `project(source, target)` outside a sketch, each a
 * list of scene objects: one object, or the objects of a list. Fewer or more
 * than two arguments, an empty list, or an argument that is not a scene
 * object is refused.
 */
export function partProjectArgs(args: readonly unknown[]): [SceneObject[], SceneObject[]] {
  const { source, target } = OperandArguments.read(args, PROJECT_CALL);
  return [source, target];
}

/** Inside a sketch: the sketch tool, projecting its arguments onto the sketch plane. */
function sketchProject(context: SceneParserContext, args: any[]): IReference {
  const projection = new Projection(args as SceneObject[]);
  context.addSceneObjects(args);
  context.addSceneObject(projection);
  return projection;
}

function build(context: SceneParserContext): ProjectFunction {
  return function project(...args: any[]) {
    if (context.getActiveSketch()) {
      return sketchProject(context, args);
    }
    const [source, target] = partProjectArgs(args);
    return OperandArguments.addTool(
      context, [...source, ...target], () => new ProjectedCurve(source, target, value => DirectionInput.from(value, context)),
    );
  } as ProjectFunction;
}

export default registerBuilder(build);
