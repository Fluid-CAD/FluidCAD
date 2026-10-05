import { SceneObject } from "../../common/scene-object.js";
import { Projection } from "../../features/2d/projection.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { IReference, ISceneObject } from "../interfaces.js";

interface ProjectFunction {
  /**
   * Projects 3D objects — faces, edges, selections — or previous sketches
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

function build(context: SceneParserContext): ProjectFunction {
  return function project(...args: any[]) {
    const projection = new Projection(args as SceneObject[]);
    context.addSceneObjects(args);
    context.addSceneObject(projection);
    return projection;
  } as ProjectFunction;
}

export default registerBuilder(build);
