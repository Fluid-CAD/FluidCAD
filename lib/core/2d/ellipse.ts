import { Point2D, Point2DLike, isPoint2DLike } from "../../math/point.js";
import { LazyVertex } from "../../features/lazy-vertex.js";
import { Ellipse } from "../../features/2d/ellipse.js";
import { Move } from "../../features/2d/move.js";
import { normalizePoint2D } from "../../helpers/normalize.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { PlaneObjectBase } from "../../features/plane-renderable-base.js";
import { isPlaneLike, PlaneLike } from "../../math/plane.js";
import { SceneObject } from "../../common/scene-object.js";
import { resolvePlane } from "../../helpers/resolve.js";
import { IExtrudableGeometry, ISceneObject } from "../interfaces.js";

interface EllipseFunction {
  /**
   * Draws an ellipse at the current position.
   * @param rx - Semi-radius along the plane's X axis
   * @param ry - Semi-radius along the plane's Y axis
   */
  (rx: number, ry: number): IExtrudableGeometry;
  /**
   * Draws an ellipse at a given center.
   * @param center - The center point
   * @param rx - Semi-radius along the plane's X axis
   * @param ry - Semi-radius along the plane's Y axis
   */
  (center: Point2DLike, rx: number, ry: number): IExtrudableGeometry;
  /**
   * Draws an ellipse on a specific plane.
   * @param targetPlane - The plane to draw on
   * @param rx - Semi-radius along the plane's X axis
   * @param ry - Semi-radius along the plane's Y axis
   */
  (targetPlane: PlaneLike | ISceneObject, rx: number, ry: number): IExtrudableGeometry;
  /**
   * Draws an ellipse at a given center on a specific plane.
   * @param targetPlane - The plane to draw on
   * @param center - The center point in plane-local coordinates
   * @param rx - Semi-radius along the plane's X axis
   * @param ry - Semi-radius along the plane's Y axis
   */
  (targetPlane: PlaneLike | ISceneObject, center: Point2DLike, rx: number, ry: number): IExtrudableGeometry;
}

function toPoint2D(p: Point2DLike): Point2D {
  if (p instanceof Point2D) {
    return p;
  }
  if (p instanceof LazyVertex) {
    return p.asPoint2D();
  }
  if (Array.isArray(p)) {
    return new Point2D(p[0], p[1]);
  }
  return new Point2D((p as { x: number; y: number }).x, (p as { x: number; y: number }).y);
}

function build(context: SceneParserContext): EllipseFunction {
  return function ellipse() {
    let planeObj: PlaneObjectBase | null = null;
    let argOffset = 0;

    if (arguments.length > 0) {
      const firstArg = arguments[0];
      if (isPlaneLike(firstArg) || (firstArg instanceof SceneObject && !isPoint2DLike(firstArg))) {
        if (context.getActiveSketch() !== null) {
          throw new Error("ellipse(plane, ...) cannot be used inside a sketch. Use ellipse(...) instead.");
        }
        planeObj = resolvePlane(firstArg, context);
        argOffset = 1;
      }
    }

    const argCount = arguments.length - argOffset;

    if (argCount === 2) {
      const rx = arguments[argOffset] as number;
      const ry = arguments[argOffset + 1] as number;
      const e = new Ellipse(rx, ry, planeObj);
      context.addSceneObject(e);
      return e;
    }

    if (argCount === 3) {
      const centerArg = arguments[argOffset];
      const rx = arguments[argOffset + 1] as number;
      const ry = arguments[argOffset + 2] as number;

      if (planeObj) {
        // Standalone (plane, center, rx, ry): center is plane-local. Move
        // can't run outside a sketch, so resolve the center eagerly into the
        // Ellipse via centerOverride.
        const center = toPoint2D(centerArg);
        const e = new Ellipse(rx, ry, planeObj, center);
        context.addSceneObject(e);
        return e;
      }

      const center = normalizePoint2D(centerArg);
      const e = new Ellipse(rx, ry, null);
      context.addSceneObjects([new Move(center), e]);
      return e;
    }

    throw new Error("Invalid arguments for ellipse()");
  } as EllipseFunction;
}

export default registerBuilder(build);
