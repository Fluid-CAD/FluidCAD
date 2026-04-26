import { Offset } from "../../features/2d/offset.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { PlaneLike } from "../../math/plane.js";
import { GeometrySceneObject } from "../../features/2d/geometry.js";
import { resolvePlane } from "../../helpers/resolve.js";
import { IOffset, ISceneObject } from "../interfaces.js";
import { Extrudable } from "../../helpers/types.js";

interface OffsetFunction {
  /**
   * Offsets the current sketch geometry by the given distance.
   * @param distance - The offset distance (defaults to 1)
   * @param removeOriginal - Whether to remove the original geometry
   */
  (distance?: number, removeOriginal?: boolean): IOffset;
  /**
   * Offsets source geometries onto a target plane.
   * @param targetPlane - The plane to offset onto
   * @param distance - The offset distance
   * @param removeOriginal - Whether to remove the original geometry
   * @param sourceGeometries - The geometries to offset
   */
  (targetPlane: PlaneLike | ISceneObject, distance: number, removeOriginal: boolean, ...sourceGeometries: Extrudable[]): IOffset;
}

function build(context: SceneParserContext): OffsetFunction {
  return function offset(...args: any[]) {
    // Plane-first mode: offset(plane, distance, removeOriginal, ...sourceGeometries)
    // Detected when first arg is not a number/undefined.
    if (args.length > 0 && args[0] !== undefined && typeof args[0] !== 'number' && typeof args[0] !== 'boolean') {
      if (context.getActiveSketch() !== null) {
        throw new Error("offset(plane, ...) cannot be used inside a sketch. Use offset(...) instead.");
      }
      const planeObj = resolvePlane(args[0], context);
      const distance = args[1] as number ?? 1;
      const removeOriginal = args[2] as boolean ?? false;
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
