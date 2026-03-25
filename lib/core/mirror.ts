import { registerBuilder, SceneParserContext } from "../index.js";
import { normalizeAxis, normalizePlane } from "../helpers/normalize.js";
import { SceneObject } from "../common/scene-object.js";
import { Plane, PlaneLike } from "../math/plane.js";
import { Matrix4 } from "../math/matrix4.js";
import { MirrorFeature } from "../features/mirror-feature.js";
import { MirrorShape } from "../features/mirror-shape.js";
import { PlaneObjectBase } from "../features/plane-renderable-base.js";
import { PlaneObject } from "../features/plane.js";
import { AxisLike, isAxisLike } from "../math/axis.js";
import { GeometrySceneObject } from "../features/2d/geometry.js";
import { MirrorShape2D } from "../features/mirror-shape2d.js";
import { AxisObjectBase } from "../features/axis-renderable-base.js";
import { AxisObject } from "../features/axis.js";
import { AxisFromEdge } from "../features/axis-from-edge.js";
import { cloneWithTransform } from "../helpers/clone-transform.js";
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

  /**
  * [3D] Mirror (re-apply) given features across a given plane.
  * @param plane The plane to mirror across
  * @param type Must be 'feature'
  * @param objects The features to mirror
  */
  (plane: PlaneLike, type: 'feature', ...objects: ISceneObject[]): ISceneObject;
}

function build(context: SceneParserContext): MirrorFunction {
  return function mirror(): any {

    if (arguments.length === 1) {
      if (isAxisLike(arguments[0] || arguments[0] instanceof SceneObject)) {
        let axis: AxisObjectBase = null;
        if (arguments[0] instanceof AxisObjectBase) {
          axis = arguments[0] as AxisObjectBase;
        }
        else if (arguments[0] instanceof SceneObject) {
          const line = arguments[0] as SceneObject;
          axis = new AxisFromEdge(line);
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

      // 3D feature mirror: mirror(plane, 'feature', ...objects)
      if (args[1] === 'feature') {
        const targetObjects = args.slice(2) as SceneObject[];

        let planeObj: PlaneObjectBase;
        let normalizedPlane: Plane;
        if (args[0] instanceof PlaneObjectBase) {
          planeObj = args[0] as PlaneObjectBase;
          planeObj.build();
          normalizedPlane = planeObj.getPlane();
        }
        else {
          normalizedPlane = normalizePlane(args[0]);
          planeObj = new PlaneObject(normalizedPlane);
          planeObj.build();
          context.addSceneObject(planeObj);
        }

        const matrix = Matrix4.mirrorPlane(normalizedPlane.normal, normalizedPlane.origin);
        const mirror = new MirrorFeature(planeObj, matrix);
        const mirrorTree = cloneWithTransform(targetObjects, matrix, mirror);

        console.log('Mirror: Transformed objects:', mirrorTree.map(o => o.getType()));

        context.addSceneObject(mirror);
        context.addSceneObjects(mirrorTree);
        return mirror;
      }

      // 2D mirror with target objects: mirror(axis/line, geometries[])
      if (isAxisLike(args[0]) || args[0] instanceof SceneObject) {
        let axis: AxisObjectBase = null;
        if (args[0] instanceof AxisObjectBase) {
          axis = args[0] as AxisObjectBase;
        }
        else if (args[0] instanceof SceneObject) {
          const line = args[0] as SceneObject;
          axis = new AxisFromEdge(line);
          context.addSceneObject(axis);
        }
        else {
          const a = normalizeAxis(args[0]);
          axis = new AxisObject(a);
          context.addSceneObject(axis);
        }

        const targetObjects = args.slice(1) as GeometrySceneObject[];
        const mirror = new MirrorShape2D(axis, targetObjects);

        if (!(args[0] instanceof AxisObjectBase) && !(args[0] instanceof SceneObject)) {
          context.addSceneObject(axis);
        }

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
