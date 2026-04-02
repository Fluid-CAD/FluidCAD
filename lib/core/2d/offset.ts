import { Offset } from "../../features/2d/offset.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { PlaneLike } from "../../math/plane.js";
import { SceneObject } from "../../common/scene-object.js";
import { GeometrySceneObject } from "../../features/2d/geometry.js";
import { resolvePlane } from "../../helpers/resolve.js";
import { IExtrudableGeometry, IGeometry, ISceneObject } from "../interfaces.js";
import { Extrudable } from "../../helpers/types.js";

interface OffsetFunction {
  /**
   * Offsets the current sketch geometry by the given distance.
   * @param distance - The offset distance (defaults to 1)
   * @param removeOriginal - Whether to remove the original geometry
   */
  (distance?: number, removeOriginal?: boolean): IExtrudableGeometry;
  /**
   * Offsets source geometries onto a target plane.
   * @param distance - The offset distance
   * @param removeOriginal - Whether to remove the original geometry
   * @param targetPlane - The plane to offset onto
   * @param sourceGeometries - The geometries to offset
   */
  (distance: number, removeOriginal: boolean, targetPlane: PlaneLike | ISceneObject, ...sourceGeometries: Extrudable[]): IExtrudableGeometry;
}

function build(context: SceneParserContext): OffsetFunction {
  return function offset(...args: any[]) {
    // Outside-sketch mode: offset(distance, removeOriginal, plane, ...sourceGeometries)
    if (args.length >= 3 && !Array.isArray(args[0])) {
      const distance = args[0] as number ?? 1;
      const removeOriginal = args[1] as boolean ?? false;
      const planeObj = resolvePlane(args[2], context);
      const sourceObjects = args.slice(3) as GeometrySceneObject[];

      const off = new Offset(distance, removeOriginal, sourceObjects, planeObj);
      context.addSceneObject(off);
      return off;
    }

    // In-sketch mode: offset(distance, removeOriginal)
    const distance = args[0] as number ?? 1;
    const removeOriginal = args[1] as boolean ?? false;
    const off = new Offset(distance, removeOriginal);
    context.addSceneObject(off);
    return off;
  } as OffsetFunction;
}

export default registerBuilder(build);
