import { SceneObject } from "../../common/scene-object.js";
import { Projection } from "../../features/2d/projection.js";
import { PlaneObjectBase } from "../../features/plane-renderable-base.js";
import { resolvePlane } from "../../helpers/resolve.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { PlaneLike } from "../../math/plane.js";

interface ProjectFunction {
  // in sketch
  (...sourceObjects: SceneObject[]): Projection;

  // outside sketch
  (sourceObjects: SceneObject[], targetPlane: PlaneLike | SceneObject): Projection;
}

function build(context: SceneParserContext): ProjectFunction {
  return function project(...args: any[]) {
    if (Array.isArray(args[0])) {
      const sourceObjects = args[0] as SceneObject[];
      const planeObj: PlaneObjectBase = resolvePlane(args[1], context);

      const projection = new Projection(sourceObjects, planeObj);
      context.addSceneObject(projection);
      return projection;
    }

    const projection = new Projection(args as SceneObject[]);
    context.addSceneObject(projection);
    return projection;
  } as ProjectFunction;
}

export default registerBuilder(build);
