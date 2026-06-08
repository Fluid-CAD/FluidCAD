import { Offset } from "../../features/2d/offset.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { PlaneLike } from "../../math/plane.js";
import { GeometrySceneObject } from "../../features/2d/geometry.js";
import { resolvePlane } from "../../helpers/resolve.js";
import { IOffset, ISceneObject } from "../interfaces.js";
import { Extrudable } from "../../helpers/types.js";
import { type NumberParam, type BooleanParam, isNumberParam, isBooleanParam, resolveParam } from "../param.js";

interface OffsetFunction {
  /**
   * Offsets the current sketch geometry by the given distance.
   * @param distance - The offset distance (defaults to 1)
   * @param removeOriginal - Whether to remove the original geometry
   */
  (distance?: NumberParam, removeOriginal?: BooleanParam): IOffset;
  /**
   * Offsets source geometries onto a target plane.
   * @param targetPlane - The plane to offset onto
   * @param distance - The offset distance
   * @param removeOriginal - Whether to remove the original geometry
   * @param sourceGeometries - The geometries to offset
   */
  (targetPlane: PlaneLike | ISceneObject, distance: NumberParam, removeOriginal: BooleanParam, ...sourceGeometries: Extrudable[]): IOffset;
}

function build(context: SceneParserContext): OffsetFunction {
  return function offset(...args: any[]) {
    // Plane-first mode: offset(plane, distance, removeOriginal, ...sourceGeometries)
    // Detected when first arg is not a number/undefined.
    if (args.length > 0 && args[0] !== undefined && !isNumberParam(args[0]) && !isBooleanParam(args[0])) {
      if (context.getActiveSketch() !== null) {
        throw new Error("offset(plane, ...) cannot be used inside a sketch. Use offset(...) instead.");
      }
      const planeObj = resolvePlane(args[0], context);
      const distance = resolveParam(args[1] as NumberParam) ?? 1;
      const removeOriginal = resolveParam(args[2] as BooleanParam) ?? false;
      const sourceObjects = args.slice(3) as GeometrySceneObject[];

      const off = new Offset(distance, removeOriginal, sourceObjects, planeObj);
      context.addSceneObject(off);
      return off;
    }

    // In-sketch mode: offset(distance, removeOriginal)
    const distance = isNumberParam(args[0]) ? resolveParam(args[0] as NumberParam) : 1;
    const removeOriginal = isBooleanParam(args[1]) ? resolveParam(args[1] as BooleanParam) : false;
    const off = new Offset(distance, removeOriginal);
    context.addSceneObject(off);
    return off;
  } as OffsetFunction;
}

export default registerBuilder(build);
