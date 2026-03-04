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
import { LazySceneObject } from "../features/lazy-scene-object.js";

interface MirrorFunction {

  /**
  * [2D] Mirror all sketch geometries across a given line.
  * @param line The line to mirror across
  */
  (line: SceneObject): MirrorShape2D;

  /**
  * [2D] Mirror all sketch geometries across a given axis.
  * @param axis The axis to mirror across
  */
  (axis: AxisLike): MirrorShape2D;

  /**
  * [2D] Mirror given sketch geometries across a given line.
  * @param line The line to mirror across
  * @param geometries The geometries to mirror
  */
  (line: SceneObject, geometries: SceneObject[]): MirrorShape2D;

  /**
  * [2D] Mirror given sketch geometries across a given axis.
  * @param axis The axis to mirror across
  * @param geometries The geometries to mirror
  */
  (axis: AxisLike, geometries: SceneObject[]): MirrorShape2D;

  /**
  * [3D] Mirror all scene shapes across a given plane.
  * @param plane The plane to mirror across
  */
  (plane: PlaneLike): MirrorShape;

  /**
  * [3D] Mirror (re-apply) given features across a given plane.
  * @param plane The plane to mirror across
  * @param objects The features to mirror
  */
  (plane: PlaneLike, objects: SceneObject[], type?: 'feature'): MirrorFeature;

  /**
  * [3D] Mirror given shapes across a given plane.
  * @param plane The plane to mirror across
  * @param objects The shapes to mirror
  */
  (plane: PlaneLike, objects: SceneObject[], type?: 'shape'): MirrorShape;
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

    if (arguments.length === 2) {

      if (isAxisLike(arguments[0]) || arguments[0] instanceof SceneObject) {
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

        const targetObjects = arguments[1] as GeometrySceneObject[];
        const mirror = new MirrorShape2D(axis, targetObjects);

        if (!(arguments[0] instanceof AxisObjectBase) && !(arguments[0] instanceof SceneObject)) {
          context.addSceneObject(axis);
        }

        context.addSceneObject(mirror);
        return mirror;
      }

      // default to shape mirror
      const normalizedPlane = normalizePlane(arguments[0]);
      const targetObjects = arguments[1] as SceneObject[];

      let planeObj: PlaneObjectBase;
      if (!(normalizedPlane instanceof PlaneObjectBase)) {
        planeObj = new PlaneObject(normalizedPlane);
        context.addSceneObject(planeObj);
      }
      else {
        planeObj = normalizedPlane;
      }

      const mirror = new MirrorShape(planeObj, targetObjects);
      context.addSceneObject(mirror);
      return mirror;
    }
    else if (arguments.length === 3) {

      let planeObj: PlaneObjectBase
      let normalizedPlane: Plane;
      if (arguments[0] instanceof PlaneObjectBase) {
        planeObj = arguments[0] as PlaneObjectBase;
        planeObj.build();
        normalizedPlane = planeObj.getPlane();
      }
      else {
        normalizedPlane = normalizePlane(arguments[0]);
        planeObj = new PlaneObject(normalizedPlane);
        planeObj.build()
        context.addSceneObject(planeObj);
      }

      const targetObjects = arguments[1] as SceneObject[];

      const type = arguments[2] as 'feature' | 'shape';
      if (type === 'shape') {
        const mirror = new MirrorShape(planeObj, targetObjects);
        context.addSceneObject(mirror);
        return mirror;
      }
      else {
        const mirrorTree: SceneObject[] = [];
        const matrix = Matrix4.mirrorPlane(normalizedPlane.normal, normalizedPlane.origin);
        const mirror = new MirrorFeature(planeObj);

        for (const obj of targetObjects) {
          const dependenciesTree = obj.clone();

          for (const dependency of dependenciesTree) {
            if (dependency instanceof LazySceneObject) {
              continue;
            }

            if (dependency.isTransformable()) {
              dependency.setTransform(matrix);
            }

            mirrorTree.push(dependency);

            if (!dependency.parentId) {
              mirror.addChildObject(dependency);
            }
          }
        }

        console.log('Mirror: Transformed objects:', mirrorTree.map(o => o.getType()));

        context.addSceneObject(mirror);
        context.addSceneObjects(mirrorTree);
        return mirror;
      }
    }

    throw new Error("Invalid arguments for axis function");
  }
}

export default registerBuilder(build);
