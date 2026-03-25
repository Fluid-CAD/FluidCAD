import { GeometrySceneObject } from "../../features/2d/geometry.js";
import { WireObject } from "../../features/2d/wire.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { PlaneObjectBase } from "../../features/plane-renderable-base.js";
import { isPlaneLike, PlaneLike } from "../../math/plane.js";
import { SceneObject } from "../../common/scene-object.js";
import { resolvePlane } from "../../helpers/resolve.js";
import { IExtrudableGeometry, IGeometry, ISceneObject } from "../interfaces.js";

interface WireFunction {
  (...args: (IGeometry | PlaneLike | ISceneObject)[]): IExtrudableGeometry;
}

function build(context: SceneParserContext): WireFunction {
  return function wire() {
    let planeObj: PlaneObjectBase | null = null;
    let argCount = arguments.length;

    // Check if last argument is a plane
    if (argCount > 0) {
      const lastArg = arguments[argCount - 1];
      if (isPlaneLike(lastArg) || (lastArg instanceof SceneObject && !(lastArg instanceof GeometrySceneObject))) {
        planeObj = resolvePlane(lastArg, context);
        argCount--;
      }
    }

    // Collect target objects from arguments
    let targetObjects: GeometrySceneObject[] = [];
    for (let i = 0; i < argCount; i++) {
      targetObjects.push(arguments[i]);
    }

    const path = new WireObject(targetObjects.length > 0 ? targetObjects : null, planeObj);
    context.addSceneObject(path);
    return path;
  } as WireFunction;
}

export default registerBuilder(build);
