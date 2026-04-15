import { SceneObject } from "../../common/scene-object.js";
import { Intersect } from "../../features/2d/intersect.js";
import { PlaneObjectBase } from "../../features/plane-renderable-base.js";
import { resolvePlane } from "../../helpers/resolve.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { PlaneLike } from "../../math/plane.js";
import { IExtrudableGeometry, ISceneObject } from "../interfaces.js";

interface IntersectFunction {
  /**
   * Intersects 3D objects with the current sketch plane, producing cross-section edges.
   * @param sourceObjects - The 3D objects to intersect
   */
  (...sourceObjects: ISceneObject[]): IExtrudableGeometry;

  /**
   * Intersects 3D objects with a target plane, producing cross-section edges.
   * @param sourceObjects - The 3D objects to intersect
   * @param targetPlane - The plane to intersect with
   */
  (sourceObjects: ISceneObject[], targetPlane: PlaneLike | ISceneObject): IExtrudableGeometry;
}

function build(context: SceneParserContext): IntersectFunction {
  return function intersect(...args: any[]) {
    if (Array.isArray(args[0])) {
      const sourceObjects = args[0] as SceneObject[];
      context.addSceneObjects(sourceObjects);
      const planeObj: PlaneObjectBase = resolvePlane(args[1], context);

      const result = new Intersect(sourceObjects, planeObj);
      context.addSceneObject(result);
      return result;
    }

    const result = new Intersect(args as SceneObject[]);
    context.addSceneObjects(args);
    context.addSceneObject(result);
    return result;
  } as IntersectFunction;
}

export default registerBuilder(build);
