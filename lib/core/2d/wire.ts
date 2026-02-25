import { GeometrySceneObject } from "../../features/2d/geometry.js";
import { WireObject } from "../../features/2d/wire.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { PlaneObjectBase } from "../../features/plane-renderable-base.js";
import { isPlaneLike, PlaneLike } from "../../math/plane.js";
import { SceneObject } from "../../common/scene-object.js";
import { resolvePlane } from "../../helpers/resolve.js";

interface WireFunction {
  (targetObjects: GeometrySceneObject[]): WireObject;
  (targetObjects: GeometrySceneObject[], targetPlane: PlaneLike | SceneObject): WireObject;
}

function build(context: SceneParserContext): WireFunction {
  return function wire(targetObjects: GeometrySceneObject[]) {
    let planeObj: PlaneObjectBase | null = null;

    if (arguments.length >= 2) {
      const lastArg = arguments[1];
      if (isPlaneLike(lastArg) || lastArg instanceof SceneObject) {
        planeObj = resolvePlane(lastArg, context);
      }
    }

    const path = new WireObject(targetObjects, planeObj);
    context.addSceneObject(path);
    return path;
  }
}

export default registerBuilder(build);
