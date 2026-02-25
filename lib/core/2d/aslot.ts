import { Point2DLike, isPoint2DLike } from "../../math/point.js";
import { Move } from "../../features/2d/move.js";
import { Slot } from "../../features/2d/slot.js";
import { normalizePoint2D } from "../../helpers/normalize.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { PlaneObjectBase } from "../../features/plane-renderable-base.js";
import { isPlaneLike, PlaneLike } from "../../math/plane.js";
import { SceneObject } from "../../common/scene-object.js";
import { resolvePlane } from "../../helpers/resolve.js";

interface ASlotFunction {
  (distance: number, radius: number, angle: number, centered?: boolean): Slot;
  (start: Point2DLike, distance: number, radius: number, angle: number): Slot;
  (distance: number, radius: number, angle: number, targetPlane: PlaneLike | SceneObject): Slot;
  (distance: number, radius: number, angle: number, centered: boolean, targetPlane: PlaneLike | SceneObject): Slot;
}

function build(context: SceneParserContext): ASlotFunction {
  return function aSlot() {
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

    if (typeof arguments[0] !== 'number') {
      // aslot(start, distance, radius, angle)
      const start = normalizePoint2D(arguments[0]);
      const distance = arguments[1] as number;
      const radius = arguments[2] as number;
      const angle = arguments[3] as number;
      const s = new Slot(distance, radius, false, angle, planeObj);
      context.addSceneObjects([new Move(start), s]);
      return s;
    }

    const distance = arguments[0] as number;
    const radius = arguments[1] as number;
    const angle = arguments[2] as number;
    const centered = argCount === 4 ? arguments[3] as boolean : false;

    const s = new Slot(distance, radius, centered, angle, planeObj);
    context.addSceneObject(s);

    return s;
  } as ASlotFunction;
}

export default registerBuilder(build);
