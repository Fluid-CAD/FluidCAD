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
import { AxisFromConnector } from "../features/axis-from-connector.js";
import { ConnectorAxis } from "../features/connector-axis.js";
import { IConnector, ISceneObject } from "../core/interfaces.js";

/**
 * The plane a statement's argument names. A `plane()` statement passed in is
 * already in the scene under its own row and comes back untouched; a plane the
 * call spells inline — `mirror('yz', …)`, `repeat('mirror', 'yz', …)`, or a
 * picked face — is synthesized here to serve that one build, so it is marked
 * internal and the timeline leaves it out. Same rule, same reason as
 * `sketch('xy', …)`.
 */
export function resolvePlane(p: PlaneLike | ISceneObject, context: SceneParserContext): PlaneObjectBase {
  if (p instanceof PlaneObjectBase) {
    return p;
  }

  if (isPlaneLike(p)) {
    const planeObj = new PlaneObject(normalizePlane(p));
    planeObj.markInternal();
    context.addSceneObject(planeObj);
    return planeObj;
  }

  if ((p as any) instanceof SceneObject) {
    context.addSceneObject(p as SceneObject);
    const planeObj = new PlaneFromObject(p as SceneObject);
    planeObj.markInternal();
    context.addSceneObject(planeObj);
    return planeObj;
  }
  throw new Error('Invalid argument: expected a plane or a scene object');
}

/**
 * The axis object a statement's axis argument names — the one place every
 * axis-taking builder (revolve, rotate, helix, repeat, a custom feature's
 * axis value) reads it through. An `axis()` statement passed in comes back
 * untouched. A connector — a `connector()` variable or one of its copies,
 * `bolt.instance(2)` — stands for its Z axis through its origin: an internal
 * {@link AxisFromConnector} that adds no row and draws no line. Any other
 * scene object is an edge the axis lies along, and a world axis name or an
 * `Axis` a fixed one.
 */
export function resolveAxis(arg: AxisLike | IConnector | ISceneObject, context: SceneParserContext): AxisObjectBase {
  if (arg instanceof AxisObjectBase) {
    return arg;
  }

  const connector = ConnectorAxis.connectorOf(arg);
  if (connector) {
    const axis = AxisFromConnector.inline(connector);
    context.addSceneObject(axis);
    return axis;
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
