import { normalizePlane } from "../helpers/normalize.js";
import { registerBuilder, SceneParserContext } from "../index.js";
import { isPlaneLike, PlaneLike, PlaneTransformOptions } from "../math/plane.js";
import { PlaneObject } from "../features/plane.js";
import { PlaneObjectBase } from "../features/plane-renderable-base.js";
import { PlaneMiddleRenderable } from "../features/plane-mid.js";
import { SceneObject } from "../common/scene-object.js";
import { PlaneFromObject } from "../features/plane-from-object.js";
import { IPlane, ISceneObject } from "./interfaces.js";

export type PlaneRenderableOptions = PlaneTransformOptions

/**
 * Where to place a plane along an edge: a named position, or a normalized
 * distance from the edge start (`0`) to its end (`1`). `0.5` is the midpoint.
 */
export type EdgePlanePosition = 'start' | 'middle' | 'end' | number;

interface PlaneFunction {
  /**
   * Creates a plane from a standard plane or normal vector.
   * @param plane - The standard plane or normal vector
   */
  (plane: PlaneLike): IPlane;
  /**
   * Creates a plane with transform options.
   * @param plane - The standard plane or normal vector
   * @param options - Transform options (offset, rotate, etc.)
   */
  (plane: PlaneLike, options: PlaneRenderableOptions): IPlane;
  /**
   * Creates a plane with an offset.
   * @param plane - The standard plane or normal vector
   * @param offset - The offset distance
   */
  (plane: PlaneLike, offset: number): IPlane;
  /**
   * Creates a plane from a selection. A selected face yields that face's
   * plane; a selected edge yields a plane at the edge start, oriented normal
   * to the edge and facing outward (away from the edge body), like a start cap.
   * @param selection - The selected face or edge to create a plane from
   */
  (selection: ISceneObject): IPlane;
  /**
   * Creates a plane from a face selection with transform options.
   * @param selection - The selected face to create a plane from
   * @param options - Transform options (offset, rotate, etc.)
   */
  (selection: ISceneObject, options: PlaneRenderableOptions): IPlane;
  /**
   * Creates a plane from a selection with a numeric second argument. For a
   * face, the number is the offset distance along the face normal. For an
   * edge, it is a normalized position from `0` (start) to `1` (end), and the
   * plane is created at that point oriented normal to the edge. The normal
   * follows the edge's forward direction, except at the start (`0`) where it
   * faces outward (away from the edge body), so both ends read like caps.
   * @param selection - The selected face or edge
   * @param offsetOrPosition - Face: offset distance. Edge: normalized 0–1 position.
   */
  (selection: ISceneObject, offsetOrPosition: number): IPlane;
  /**
   * Creates a plane at a named position along an edge, oriented normal to the
   * edge. At `'start'` the normal faces outward (away from the edge body);
   * `'middle'` and `'end'` follow the edge's forward direction.
   * @param edge - The selected edge
   * @param position - `'start'`, `'middle'`, or `'end'`
   */
  (edge: ISceneObject, position: 'start' | 'middle' | 'end'): IPlane;
  /**
   * Transforms an existing plane with options.
   * @param plane - The existing plane to transform
   * @param options - Transform options (offset, rotate, etc.)
   */
  (plane: IPlane, options: PlaneRenderableOptions): IPlane;
  /**
   * Creates a plane midway between two standard planes or normal vectors.
   * @param p1 - The first standard plane or normal vector
   * @param p2 - The second standard plane or normal vector
   * @param options - Transform options (offset, rotate, etc.)
   */
  (p1: PlaneLike, p2: PlaneLike, options?: PlaneRenderableOptions): IPlane;
  /**
   * Creates a plane midway between two existing Plane objects.
   * @param p1 - The first Plane object
   * @param p2 - The second Plane object
   * @param options - Transform options (offset, flip, sticky, etc.)
   */
  (p1: IPlane, p2: IPlane, options?: PlaneRenderableOptions): IPlane;
}

function build(context: SceneParserContext): PlaneFunction {
  return function plane(): PlaneObjectBase {
    if (arguments.length === 1) {
       if (arguments[0] instanceof SceneObject) {
         context.addSceneObject(arguments[0]);
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
      const a0 = arguments[0];
      const a1 = arguments[1];

      // Plane midway between two planes / plane-likes.
      if ((a0 instanceof PlaneObjectBase || isPlaneLike(a0)) &&
        (a1 instanceof PlaneObjectBase || isPlaneLike(a1))) {
        const p1 = a0 instanceof PlaneObjectBase ? a0 : new PlaneObject(normalizePlane(a0));
        const p2 = a1 instanceof PlaneObjectBase ? a1 : new PlaneObject(normalizePlane(a1));

        context.addSceneObject(p1);
        context.addSceneObject(p2);
        const pln = new PlaneMiddleRenderable(p1, p2);
        context.addSceneObject(pln);
        return pln;
      }

      // From a scene object. A face reads the second argument as an offset
      // distance / transform options; an edge reads it as a normalized 0–1
      // position (or 'start'/'middle'/'end'). The face-vs-edge decision is
      // deferred to PlaneFromObject.build(), where the source shape is known.
      if (a0 instanceof SceneObject) {
        context.addSceneObject(a0);
        const pln = new PlaneFromObject(a0, a1);
        context.addSceneObject(pln);
        return pln;
      }

      // From a plane-like: number → offset, object → transform options.
      if (isPlaneLike(a0)) {
        const options: PlaneRenderableOptions =
          typeof a1 === 'number' ? { offset: a1 } : a1;
        const pln = new PlaneObject(normalizePlane(a0), options);
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

        context.addSceneObject(a1);
        context.addSceneObject(a2);
        const pln = new PlaneMiddleRenderable(a1, a2, options);
        context.addSceneObject(pln);
        return pln;
      }
    }

    throw new Error("Invalid arguments for plane function");

  }
}

export default registerBuilder(build);
