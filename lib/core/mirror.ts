import { registerBuilder, SceneParserContext } from "../index.js";
import { normalizeAxis, normalizePlane } from "../helpers/normalize.js";
import { SceneObject } from "../common/scene-object.js";
import { PlaneLike } from "../math/plane.js";
import { MirrorShape } from "../features/mirror-shape.js";
import { PlaneObjectBase } from "../features/plane-renderable-base.js";
import { PlaneObject } from "../features/plane.js";
import { AxisLike, isAxisLike, isStandardAxis } from "../math/axis.js";
import { GeometrySceneObject } from "../features/2d/geometry.js";
import { MirrorShape2D } from "../features/mirror-shape2d.js";
import { AxisObjectBase } from "../features/axis-renderable-base.js";
import { AxisObject } from "../features/axis.js";
import { AxisFromEdge } from "../features/axis-from-edge.js";
import { ISceneObject } from "./interfaces.js";

const axisToPlaneName: Record<string, string> = { x: "yz", y: "xz", z: "xy" };

interface MirrorFunction {

  /**
  * [2D] Mirror all sketch geometries across a given line.
  * @param line The line to mirror across
  */
  (line: ISceneObject): ISceneObject;

  /**
  * [2D] Mirror all sketch geometries across a given axis.
  * @param axis The local axis to mirror across
  */
  (axis: AxisLike): ISceneObject;

  /**
  * [2D] Mirror given sketch geometries across a given line.
  * @param line The line to mirror across
  * @param geometries The geometries to mirror
  */
  (line: ISceneObject, ...geometries: ISceneObject[]): ISceneObject;

  /**
  * [2D] Mirror given sketch geometries across a given axis.
  * @param axis The local axis to mirror across
  * @param geometries The geometries to mirror
  */
  (axis: AxisLike, ...geometries: ISceneObject[]): ISceneObject;

  /**
  * [3D] Mirror all scene shapes across a given plane.
  * @param plane The plane to mirror across
  */
  (plane: PlaneLike): ISceneObject;

  /**
  * [3D] Mirror given shapes across a given plane.
  * @param plane The plane to mirror across
  * @param objects The shapes to mirror
  */
  (plane: PlaneLike, ...objects: ISceneObject[]): ISceneObject;

}

function resolveAxis(arg: any, context: SceneParserContext): AxisObjectBase {
  if (arg instanceof AxisObjectBase) {
    return arg;
  }
  if (arg instanceof SceneObject) {
    const axis = new AxisFromEdge(arg);
    context.addSceneObject(axis);
    return axis;
  }
  const a = normalizeAxis(arg);
  const axis = new AxisObject(a);
  context.addSceneObject(axis);
  return axis;
}

function resolvePlane(arg: any, context: SceneParserContext): PlaneObjectBase {
  if (arg instanceof PlaneObjectBase) {
    return arg;
  }
  const normalizedPlane = normalizePlane(arg);
  const planeObj = new PlaneObject(normalizedPlane);
  context.addSceneObject(planeObj);
  return planeObj;
}

function build(context: SceneParserContext): MirrorFunction {
  return function mirror(): any {
    const activeSketch = context.getActiveSketch();

    if (arguments.length === 1) {
      if (activeSketch && (isAxisLike(arguments[0]) || arguments[0] instanceof SceneObject)) {
        const axis = resolveAxis(arguments[0], context);
        const mirror = new MirrorShape2D(axis);
        context.addSceneObject(mirror);
        return mirror;
      }

      let planeArg = arguments[0];
      if (isStandardAxis(planeArg)) {
        planeArg = axisToPlaneName[planeArg];
      }
      const planeObj = resolvePlane(planeArg, context);
      const mirror = new MirrorShape(planeObj);
      context.addSceneObject(mirror);
      return mirror;
    }

    if (arguments.length >= 2) {
      const args = Array.from(arguments);

      if (activeSketch && (isAxisLike(args[0]) || args[0] instanceof SceneObject)) {
        const axis = resolveAxis(args[0], context);
        const targetObjects = args.slice(1) as GeometrySceneObject[];
        const mirror = new MirrorShape2D(axis, targetObjects);
        context.addSceneObject(mirror);
        return mirror;
      }

      let planeArg = args[0];
      if (isStandardAxis(planeArg)) {
        planeArg = axisToPlaneName[planeArg];
      }
      const planeObj = resolvePlane(planeArg, context);
      const targetObjects = args.slice(1) as SceneObject[];
      const mirror = new MirrorShape(planeObj, targetObjects);
      context.addSceneObject(mirror);
      return mirror;
    }

    throw new Error("Invalid arguments for mirror function");
  }
}

export default registerBuilder(build);
