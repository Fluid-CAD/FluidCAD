import { SceneObject } from "../common/scene-object.js";
import { PlaneFromObject } from "../features/plane-from-object.js";
import { PlaneObjectBase } from "../features/plane-renderable-base.js";
import { PlaneObject } from "../features/plane.js";
import { normalizeAxis, normalizePlane } from "./normalize.js";
import { SceneParserContext } from "../index.js";
import { isPlaneLike, PlaneLike } from "../math/plane.js";
import { AxisObjectBase } from "../features/axis-renderable-base.js";
import { AxisLike, isAxisLike } from "../math/axis.js";
import { AxisObject } from "../features/axis.js";
import { AxisFromEdge } from "../features/axis-from-edge.js";
import { ISceneObject } from "../core/interfaces.js";

export function resolvePlane(p: PlaneLike | ISceneObject, context: SceneParserContext): PlaneObjectBase {
  if (p instanceof PlaneObjectBase) {
    return p;
  }

  if (isPlaneLike(p)) {
    const planeObj = new PlaneObject(normalizePlane(p));
    context.addSceneObject(planeObj);
    return planeObj;
  }

  if ((p as any) instanceof SceneObject) {
    context.addSceneObject(p as SceneObject);
    const planeObj = new PlaneFromObject(p as SceneObject);
    context.addSceneObject(planeObj);
    return planeObj;
  }
  throw new Error('Invalid argument: expected a plane or a scene object');
}

export function resolveAxis(arg: AxisLike | ISceneObject, context: SceneParserContext): AxisObjectBase {
  if (arg instanceof AxisObjectBase) {
    return arg;
  }

  if ((arg as any) instanceof SceneObject) {
    context.addSceneObject(arg as SceneObject);
    const axis = new AxisFromEdge(arg as SceneObject);
    context.addSceneObject(axis);
    return axis;
  }

  if (isAxisLike(arg)) {
    const a = normalizeAxis(arg);
    const axis = new AxisObject(a)
    context.addSceneObject(axis);
    return axis;
  }

  throw new Error('Invalid argument: expected an axis or a scene object');
}
