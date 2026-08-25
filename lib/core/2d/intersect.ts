import { SceneObject } from "../../common/scene-object.js";
import { Intersect } from "../../features/2d/intersect.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { IReference, ISceneObject } from "../interfaces.js";

interface IntersectFunction {
  /**
   * Intersects 3D objects with the current sketch plane, producing cross-section edges.
   * @param sourceObjects - The 3D objects to intersect
   */
  (...sourceObjects: ISceneObject[]): IReference;
}

function build(context: SceneParserContext): IntersectFunction {
  return function intersect(...args: any[]) {
    const result = new Intersect(args as SceneObject[]);
    context.addSceneObjects(args);
    context.addSceneObject(result);
    return result;
  } as IntersectFunction;
}

export default registerBuilder(build);
