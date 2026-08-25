import { SceneObject } from "../../common/scene-object.js";
import { Projection } from "../../features/2d/projection.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { IReference, ISceneObject } from "../interfaces.js";

interface ProjectFunction {
  /**
   * Projects 3D objects onto the current sketch plane. In a constraint
   * sketch the output registers as FIXED reference geometry — constraints
   * may target it (`tangent(p, l)`, `p.ref(i)`, `p.center()`).
   * @param sourceObjects - The 3D objects to project
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
