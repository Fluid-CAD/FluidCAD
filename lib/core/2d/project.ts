import { SceneObject } from "../../common/scene-object.js";
import { Projection } from "../../features/2d/projection.js";
import { PlaneObjectBase } from "../../features/plane-renderable-base.js";
import { resolvePlane } from "../../helpers/resolve.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { PlaneLike } from "../../math/plane.js";
import { IExtrudableGeometry, ISceneObject } from "../interfaces.js";

interface ProjectFunction {
  /**
   * Projects 3D objects onto the current sketch plane.
   * @param sourceObjects - The 3D objects to project
   */
  (...sourceObjects: ISceneObject[]): IExtrudableGeometry;

  /**
   * Projects 3D objects onto a target plane.
   * @param targetPlane - The plane to project onto
   * @param sourceObjects - The 3D objects to project
   */
  (targetPlane: PlaneLike | ISceneObject, sourceObjects: ISceneObject[]): IExtrudableGeometry;
}

function build(context: SceneParserContext): ProjectFunction {
  return function project(...args: any[]) {
    // Plane-first mode: project(plane, sources[])
    if (args.length === 2 && Array.isArray(args[1])) {
      if (context.getActiveSketch() !== null) {
        throw new Error("project(plane, sources[]) cannot be used inside a sketch. Use project(...sources) instead.");
      }
      const planeObj: PlaneObjectBase = resolvePlane(args[0], context);
      const sourceObjects = args[1] as SceneObject[];
      context.addSceneObjects(sourceObjects);

      const projection = new Projection(sourceObjects, planeObj);
      context.addSceneObject(projection);
      return projection;
    }

    const projection = new Projection(args as SceneObject[]);
    context.addSceneObjects(args);
    context.addSceneObject(projection);
    return projection;
  } as ProjectFunction;
}

export default registerBuilder(build);
