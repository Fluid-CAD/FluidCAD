import { normalizePlane } from "../helpers/normalize.js";
import { registerBuilder, SceneParserContext } from "../index.js";
import { isPlaneLike, Plane, PlaneLike, PlaneTransformOptions } from "../math/plane.js";
import { PlaneObject } from "../features/plane.js";
import { PlaneObjectBase } from "../features/plane-renderable-base.js";
import { PlaneMiddleRenderable } from "../features/plane-mid.js";
import { SceneObject } from "../common/scene-object.js";
import { PlaneFromObject } from "../features/plane-from-object.js";
import { IPlane, ISceneObject } from "./interfaces.js";

export type PlaneRenderableOptions = PlaneTransformOptions & { sticky?: boolean };

interface PlaneFunction {
  /**
   * Creates a plane from a standard plane or normal vector.
   * @param plane - The standard plane or normal vector
   */
  (plane: PlaneLike): IPlane;
  /**
   * Creates a plane with transform options.
   * @param plane - The standard plane or normal vector
   * @param options - Transform options (offset, flip, sticky, etc.)
   */
  (plane: PlaneLike, options: PlaneRenderableOptions): IPlane;
  /**
   * Creates a plane with an offset.
   * @param plane - The standard plane or normal vector
   * @param offset - The offset distance
   */
  (plane: PlaneLike, offset: number): IPlane;
  /**
   * Creates a plane from a face selection.
   * @param selection - The selected face to create a plane from
   */
  (selection: ISceneObject): IPlane;
  /**
   * Creates a plane from a face selection with transform options.
   * @param selection - The selected face to create a plane from
   * @param options - Transform options (offset, flip, sticky, etc.)
   */
  (selection: ISceneObject, options: PlaneRenderableOptions): IPlane;
  /**
   * Creates a plane from a face selection with an offset.
   * @param selection - The selected face to create a plane from
   * @param offset - The offset distance
   */
  (selection: ISceneObject, offset: number): IPlane;
  /**
   * Transforms an existing plane with options.
   * @param plane - The existing plane to transform
   * @param options - Transform options (offset, flip, sticky, etc.)
   */
  (plane: IPlane, options: PlaneRenderableOptions): IPlane;
  /**
   * Creates a plane midway between two planes.
   * @param p1 - The first plane
   * @param p2 - The second plane
   * @param options - Transform options (offset, flip, sticky, etc.)
   */
  (p1: PlaneLike | IPlane, p2: PlaneLike | IPlane, options?: PlaneRenderableOptions): IPlane;
}

function build(context: SceneParserContext): PlaneFunction {
  return function plane(): PlaneObjectBase {
    if (arguments.length === 1) {
       if (arguments[0] instanceof SceneObject) {
        const pln = new PlaneFromObject(arguments[0]);
        context.addSceneObject(pln);
        return pln;
      }
      else {
        const axis = normalizePlane(arguments[0]);
        const pln = new PlaneObject(axis);
        context.addSceneObject(pln);
        return pln;
      }
    }

    if (arguments.length === 2) {
      if (typeof arguments[1] === 'number') {
        const options: PlaneRenderableOptions = { offset: arguments[1] };
        if (arguments[0] instanceof SceneObject) {
          const pln = new PlaneFromObject(arguments[0], options);
          context.addSceneObject(pln);
          return pln;
        } else if (isPlaneLike(arguments[0])) {
          const axis = normalizePlane(arguments[0]);
          const pln = new PlaneObject(axis, options);
          context.addSceneObject(pln);
          return pln;
        }
      }

      if ((arguments[0] instanceof PlaneObjectBase || isPlaneLike(arguments[0])) &&
        (arguments[1] instanceof PlaneObjectBase || isPlaneLike(arguments[1]))) {
        // axis between two others
        let a1: PlaneObjectBase;
        let a2: PlaneObjectBase;

        if (arguments[0] instanceof PlaneObjectBase) {
          a1 = arguments[0] as PlaneObjectBase;
        }
        else {
          const axis = normalizePlane(arguments[0]);
          a1 = new PlaneObject(axis);
        }

        if (arguments[1] instanceof PlaneObjectBase) {
          a2 = arguments[1] as PlaneObjectBase;
        }
        else {
          const axis = normalizePlane(arguments[1]);
          a2 = new PlaneObject(axis);
        }

        const pln = new PlaneMiddleRenderable(a1, a2);
        context.addSceneObject(pln);
        return pln;
      }
      else if (arguments[0] instanceof SceneObject) {
        const pln = new PlaneFromObject(arguments[0], arguments[1]);
        context.addSceneObject(pln);
        return pln;
      }
      else if (isPlaneLike(arguments[0])) {
        const axis1 = normalizePlane(arguments[0]);
        const options: PlaneRenderableOptions = arguments[1];
        const pln = new PlaneObject(axis1, options);
        context.addSceneObject(pln);
        return pln;
      }
    }

    if (arguments.length === 3) {
      if ((arguments[0] instanceof PlaneObjectBase || isPlaneLike((arguments[0]))) &&
        (arguments[1] instanceof PlaneObjectBase || isPlaneLike((arguments[1])))) {
        // axis between two others with options

        let a1: PlaneObjectBase;
        let a2: PlaneObjectBase;

        if (arguments[0] instanceof PlaneObjectBase) {
          a1 = arguments[0] as PlaneObjectBase;
        }
        else {
          const axis = normalizePlane(arguments[0]);
          a1 = new PlaneObject(axis);
        }

        if (arguments[1] instanceof PlaneObjectBase) {
          a2 = arguments[1] as PlaneObjectBase;
        }
        else {
          const axis = normalizePlane(arguments[1]);
          a2 = new PlaneObject(axis);
        }

        const options = arguments[2] as PlaneRenderableOptions;

        const pln = new PlaneMiddleRenderable(a1, a2, options);
        context.addSceneObject(pln);
        return pln;
      }
    }

    throw new Error("Invalid arguments for plane function");

  }
}

export default registerBuilder(build);
