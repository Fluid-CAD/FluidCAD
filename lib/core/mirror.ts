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
import { AxisFromSketch } from "../features/axis-from-sketch.js";
import { ISceneObject } from "./interfaces.js";

interface MirrorFunction {

  /**
  * [2D] Mirror all sketch geometries across a given line.
  * @param line The line to mirror across
  */
  (line: ISceneObject): ISceneObject;

  /**
  * [2D] Mirror all sketch geometries across a given axis.
  * @param axis The axis to mirror across
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
  * @param axis The axis to mirror across
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

function build(context: SceneParserContext): MirrorFunction {
  return function mirror(): any {

    if (arguments.length === 1) {
      if (isAxisLike(arguments[0] || arguments[0] instanceof SceneObject)) {
        const activeSketch = context.getActiveSketch();

        let axis: AxisObjectBase = null;
        if (arguments[0] instanceof AxisObjectBase) {
          axis = arguments[0] as AxisObjectBase;
        }
        else if (arguments[0] instanceof SceneObject) {
          const line = arguments[0] as SceneObject;
          axis = new AxisFromEdge(line);
          context.addSceneObject(axis);
        }
        else if (activeSketch && isStandardAxis(arguments[0])) {
          axis = new AxisFromSketch(activeSketch, arguments[0]);
          context.addSceneObject(axis);
        }
        else {
          const a = normalizeAxis(arguments[0]);
          axis = new AxisObject(a);
          context.addSceneObject(axis);
        }

        const mirror = new MirrorShape2D(axis);
        context.addSceneObject(mirror);
        return mirror;
      }
      else {
        const pln = arguments[0] as PlaneLike;
        let planeObj: PlaneObjectBase;
        if (!(pln instanceof PlaneObjectBase)) {
          const normalizedPlane = normalizePlane(arguments[0]);
          planeObj = new PlaneObject(normalizedPlane);
          context.addSceneObject(planeObj);
        }
        else {
          planeObj = pln;;
        }

        const mirror = new MirrorShape(planeObj);
        context.addSceneObject(mirror);
        return mirror;
      }
    }

    if (arguments.length >= 2) {
      const args = Array.from(arguments);

      // 2D mirror with target objects: mirror(axis/line, geometries[])
      if (isAxisLike(args[0]) || args[0] instanceof SceneObject) {
        const activeSketch = context.getActiveSketch();

        let axis: AxisObjectBase = null;
        if (args[0] instanceof AxisObjectBase) {
          axis = args[0] as AxisObjectBase;
        }
        else if (args[0] instanceof SceneObject) {
          const line = args[0] as SceneObject;
          axis = new AxisFromEdge(line);
          context.addSceneObject(axis);
        }
        else if (activeSketch && isStandardAxis(args[0])) {
          axis = new AxisFromSketch(activeSketch, args[0]);
          context.addSceneObject(axis);
        }
        else {
          const a = normalizeAxis(args[0]);
          axis = new AxisObject(a);
          context.addSceneObject(axis);
        }

        const targetObjects = args.slice(1) as GeometrySceneObject[];
        const mirror = new MirrorShape2D(axis, targetObjects);

        context.addSceneObject(mirror);
        return mirror;
      }

      // 3D shape mirror: mirror(plane, ...objects)
      const targetObjects = args.slice(1) as SceneObject[];

      let planeObj: PlaneObjectBase;
      if (!(args[0] instanceof PlaneObjectBase)) {
        const normalizedPlane = normalizePlane(args[0]);
        planeObj = new PlaneObject(normalizedPlane);
        context.addSceneObject(planeObj);
      }
      else {
        planeObj = args[0] as PlaneObjectBase;
      }

      const mirror = new MirrorShape(planeObj, targetObjects);
      context.addSceneObject(mirror);
      return mirror;
    }

    throw new Error("Invalid arguments for mirror function");
  }
}

export default registerBuilder(build);
