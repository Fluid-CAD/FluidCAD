import { Point2DLike, isPoint2DLike } from "../../math/point.js";
import { Move } from "../../features/2d/move.js";
import { Slot } from "../../features/2d/slot.js";
import { SlotFromEdge } from "../../features/2d/slot-from-edge.js";
import { GeometrySceneObject } from "../../features/2d/geometry.js";
import { normalizePoint2D } from "../../helpers/normalize.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { SceneObject } from "../../common/scene-object.js";
import { PlaneObjectBase } from "../../features/plane-renderable-base.js";
import { isPlaneLike, PlaneLike } from "../../math/plane.js";
import { resolvePlane } from "../../helpers/resolve.js";
import { ISlot, ISceneObject } from "../interfaces.js";

interface SlotFunction {
  (distance: number, radius: number): ISlot;
  (distance: number, radius: number, targetPlane: PlaneLike | ISceneObject): ISlot;
  (start: Point2DLike, distance: number, radius: number): ISlot;
  (geometry: ISceneObject, radius: number, deleteSource?: boolean): ISlot;
  (geometry: ISceneObject, radius: number, targetPlane: PlaneLike | ISceneObject): ISlot;
  (geometry: ISceneObject, radius: number, deleteSource: boolean, targetPlane: PlaneLike | ISceneObject): ISlot;
}

function build(context: SceneParserContext): SlotFunction {
  return function slot() {
    // SlotFromEdge path: first arg is a SceneObject (geometry)
    if (arguments[0] instanceof SceneObject) {
      const geometry = arguments[0] as GeometrySceneObject;
      const radius = arguments[1] as number;
      let deleteSource = true;
      let planeObj: PlaneObjectBase | null = null;
      let argIdx = 2;

      // Check if there's a deleteSource boolean before a potential plane
      if (argIdx < arguments.length && typeof arguments[argIdx] === 'boolean') {
        deleteSource = arguments[argIdx] as boolean;
        argIdx++;
      }

      // Check if there's a plane arg remaining
      if (argIdx < arguments.length) {
        const planeArg = arguments[argIdx];
        if (isPlaneLike(planeArg) || planeArg instanceof SceneObject) {
          planeObj = resolvePlane(planeArg, context);
        }
      }

      const slotFromEdge = new SlotFromEdge(geometry, radius, deleteSource, planeObj);
      context.addSceneObject(slotFromEdge);
      return slotFromEdge;
    }

    let planeObj: PlaneObjectBase | null = null;
    let argCount = arguments.length;

    // Detect plane as last argument
    if (argCount > 0) {
      const lastArg = arguments[argCount - 1];
      if (isPlaneLike(lastArg) || (lastArg instanceof SceneObject && !isPoint2DLike(lastArg))) {
        planeObj = resolvePlane(lastArg, context);
        argCount--;
      }
    }

    // slot(distance, radius)
    if (argCount === 2 && typeof arguments[0] === 'number') {
      const distance = arguments[0] as number;
      const radius = arguments[1] as number;
      const s = new Slot(distance, radius, planeObj);
      context.addSceneObject(s);
      return s;
    }

    // slot(start, distance, radius)
    if (argCount === 3) {
      const start = normalizePoint2D(arguments[0]);
      const distance = arguments[1] as number;
      const radius = arguments[2] as number;
      const s = new Slot(distance, radius, planeObj);
      context.addSceneObjects([new Move(start), s]);
      return s;
    }

    throw new Error("Invalid arguments for slot()");
  } as SlotFunction;
}

export default registerBuilder(build);
