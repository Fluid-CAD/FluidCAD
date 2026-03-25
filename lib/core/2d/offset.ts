import { Offset } from "../../features/2d/offset.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { PlaneLike } from "../../math/plane.js";
import { SceneObject } from "../../common/scene-object.js";
import { GeometrySceneObject } from "../../features/2d/geometry.js";
import { resolvePlane } from "../../helpers/resolve.js";
import { IExtrudableGeometry, IGeometry, ISceneObject } from "../interfaces.js";

interface OffsetFunction {
  (distance?: number, removeOriginal?: boolean): IExtrudableGeometry;
  (sourceGeometries: IGeometry[], distance: number, removeOriginal: boolean, targetPlane: PlaneLike | ISceneObject): IExtrudableGeometry;
}

function build(context: SceneParserContext): OffsetFunction {
  return function offset() {
    // Outside-sketch mode: offset(sourceGeometries[], distance, removeOriginal, plane)
    if (Array.isArray(arguments[0])) {
      const sourceObjects = arguments[0] as GeometrySceneObject[];
      const distance = arguments[1] as number ?? 1;
      const removeOriginal = arguments[2] as boolean ?? false;
      const planeObj = resolvePlane(arguments[3], context);

      // Collect geometries from source objects
      const off = new Offset(distance, removeOriginal, sourceObjects, planeObj);
      context.addSceneObject(off);
      return off;
    }

    // In-sketch mode: offset(distance, removeOriginal)
    const distance = arguments[0] as number ?? 1;
    const removeOriginal = arguments[1] as boolean ?? false;
    const off = new Offset(distance, removeOriginal);
    context.addSceneObject(off);
    return off;
  } as OffsetFunction;
}

export default registerBuilder(build);
