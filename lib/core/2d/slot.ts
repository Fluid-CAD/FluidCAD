import { Point2DLike, isPoint2DLike } from "../../math/point.js";
import { Move } from "../../features/2d/move.js";
import { Slot } from "../../features/2d/slot.js";
import { SlotFromEdge } from "../../features/2d/slot-from-edge.js";
import { GeometrySceneObject } from "../../features/2d/geometry.js";
import { normalizePoint2D } from "../../helpers/normalize.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { SceneObject } from "../../common/scene-object.js";
import { PlaneObjectBase } from "../../features/plane-renderable-base.js";
import { isPlaneLike, PlaneLike } from "../../math/plane.js";
import { resolvePlane } from "../../helpers/resolve.js";
import { ISlot, ISceneObject } from "../interfaces.js";

interface SlotFunction {
  /**
   * Draws a slot with the given length and end radius.
   * @param distance - The slot length
   * @param radius - The end cap radius
   */
  (distance: number, radius: number): ISlot;
  /**
   * Draws a slot on a specific plane.
   * @param targetPlane - The plane to draw on
   * @param distance - The slot length
   * @param radius - The end cap radius
   */
  (targetPlane: PlaneLike | ISceneObject, distance: number, radius: number): ISlot;
  /**
   * Draws a slot from a start point with the given length and end radius.
   * @param start - The start point
   * @param distance - The slot length
   * @param radius - The end cap radius
   */
  (start: Point2DLike, distance: number, radius: number): ISlot;
  /**
   * Creates a slot from a geometry edge with the given radius.
   * @param geometry - The source geometry edge
   * @param radius - The end cap radius
   * @param deleteSource - Whether to delete the source geometry (defaults to true)
   */
  (geometry: ISceneObject, radius: number, deleteSource?: boolean): ISlot;
  /**
   * Creates a slot from a geometry edge on a specific plane.
   * @param targetPlane - The plane to draw on
   * @param geometry - The source geometry edge
   * @param radius - The end cap radius
   */
  (targetPlane: PlaneLike | ISceneObject, geometry: ISceneObject, radius: number): ISlot;
  /**
   * Creates a slot from a geometry edge, optionally keeping the source, on a specific plane.
   * @param targetPlane - The plane to draw on
   * @param geometry - The source geometry edge
   * @param radius - The end cap radius
   * @param deleteSource - Whether to delete the source geometry
   */
  (targetPlane: PlaneLike | ISceneObject, geometry: ISceneObject, radius: number, deleteSource: boolean): ISlot;
}

function build(context: SceneParserContext): SlotFunction {
  return function slot() {
    const inSketch = context.getActiveSketch() !== null;

    // Detect plane as first argument (only valid outside a sketch).
    // Inside a sketch, a SceneObject at position 0 means SlotFromEdge geometry, not plane.
    let planeObj: PlaneObjectBase | null = null;
    let argOffset = 0;
    if (arguments.length > 0) {
      const firstArg = arguments[0];
      const looksLikePlane = isPlaneLike(firstArg) ||
        (firstArg instanceof SceneObject && !isPoint2DLike(firstArg) && !inSketch);
      if (looksLikePlane) {
        if (inSketch) {
          throw new Error("slot(plane, ...) cannot be used inside a sketch. Use slot(...) instead.");
        }
        planeObj = resolvePlane(firstArg, context);
        argOffset = 1;
      }
    }

    // SlotFromEdge path: first non-plane arg is a SceneObject (geometry)
    if (arguments[argOffset] instanceof SceneObject && !isPoint2DLike(arguments[argOffset])) {
      const geometry = arguments[argOffset] as GeometrySceneObject;
      const radius = arguments[argOffset + 1] as number;
      let deleteSource = true;
      if (arguments.length > argOffset + 2 && typeof arguments[argOffset + 2] === 'boolean') {
        deleteSource = arguments[argOffset + 2] as boolean;
      }

      const slotFromEdge = new SlotFromEdge(geometry, radius, deleteSource, planeObj);
      context.addSceneObject(slotFromEdge);
      return slotFromEdge;
    }

    const argCount = arguments.length - argOffset;

    // slot(distance, radius)
    if (argCount === 2 && typeof arguments[argOffset] === 'number') {
      const distance = arguments[argOffset] as number;
      const radius = arguments[argOffset + 1] as number;
      const s = new Slot(distance, radius, planeObj);
      context.addSceneObject(s);
      return s;
    }

    // slot(start, distance, radius) — in-sketch only
    if (argCount === 3 && argOffset === 0) {
      const start = normalizePoint2D(arguments[0]);
      const distance = arguments[1] as number;
      const radius = arguments[2] as number;
      const s = new Slot(distance, radius, planeObj);
      context.addSceneObjects([new Move(start), s]);
      return s;
    }

    throw new Error("Invalid arguments for slot()");
  } as SlotFunction;
}

export default registerBuilder(build);
