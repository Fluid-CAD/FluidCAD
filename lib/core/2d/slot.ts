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
import { type NumberParam, type BooleanParam, isNumberParam, isBooleanParam, resolveParam } from "../param.js";

interface SlotFunction {
  /**
   * Draws a slot with the given length and end radius.
   * @param distance - The slot length
   * @param radius - The end cap radius
   */
  (distance: NumberParam, radius: NumberParam): ISlot;
  /**
   * Draws a slot on a specific plane.
   * @param targetPlane - The plane to draw on
   * @param distance - The slot length
   * @param radius - The end cap radius
   */
  (targetPlane: PlaneLike | ISceneObject, distance: NumberParam, radius: NumberParam): ISlot;
  /**
   * Draws a slot from a start point with the given length and end radius.
   * @param start - The start point
   * @param distance - The slot length
   * @param radius - The end cap radius
   */
  (start: Point2DLike, distance: NumberParam, radius: NumberParam): ISlot;
  /**
   * Draws a slot between two cap-center points with the given radius.
   * @param start - Center of the first cap
   * @param end - Center of the second cap
   * @param radius - The end cap radius
   */
  (start: Point2DLike, end: Point2DLike, radius: number): ISlot;
  /**
   * Creates a slot from a geometry edge with the given radius.
   * @param geometry - The source geometry edge
   * @param radius - The end cap radius
   * @param deleteSource - Whether to delete the source geometry (defaults to true)
   */
  (geometry: ISceneObject, radius: NumberParam, deleteSource?: BooleanParam): ISlot;
  /**
   * Creates a slot from a geometry edge on a specific plane.
   * @param targetPlane - The plane to draw on
   * @param geometry - The source geometry edge
   * @param radius - The end cap radius
   */
  (targetPlane: PlaneLike | ISceneObject, geometry: ISceneObject, radius: NumberParam): ISlot;
  /**
   * Creates a slot from a geometry edge, optionally keeping the source, on a specific plane.
   * @param targetPlane - The plane to draw on
   * @param geometry - The source geometry edge
   * @param radius - The end cap radius
   * @param deleteSource - Whether to delete the source geometry
   */
  (targetPlane: PlaneLike | ISceneObject, geometry: ISceneObject, radius: NumberParam, deleteSource: BooleanParam): ISlot;
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
      const radius = resolveParam(arguments[argOffset + 1] as NumberParam);
      let deleteSource = true;
      if (arguments.length > argOffset + 2 && isBooleanParam(arguments[argOffset + 2])) {
        deleteSource = resolveParam(arguments[argOffset + 2] as BooleanParam);
      }

      const slotFromEdge = new SlotFromEdge(geometry, radius, deleteSource, planeObj);
      context.addSceneObject(slotFromEdge);
      return slotFromEdge;
    }

    const argCount = arguments.length - argOffset;

    // slot(distance, radius)
    if (argCount === 2 && isNumberParam(arguments[argOffset])) {
      const distance = resolveParam(arguments[argOffset] as NumberParam);
      const radius = resolveParam(arguments[argOffset + 1] as NumberParam);
      const s = new Slot(distance, radius, planeObj);
      context.addSceneObject(s);
      return s;
    }

    // slot(start, end, radius) — in-sketch only
    if (argCount === 3 && argOffset === 0
      && isPoint2DLike(arguments[0]) && isPoint2DLike(arguments[1])) {
      const start = normalizePoint2D(arguments[0]);
      const end = normalizePoint2D(arguments[1]);
      const radius = arguments[2] as number;
      const s = Slot.fromTwoPoints(start, end, radius, planeObj);
      context.addSceneObjects([new Move(start), s]);
      return s;
    }


    // slot(start, distance, radius) — in-sketch only
    if (argCount === 3 && argOffset === 0) {
      const start = normalizePoint2D(arguments[0]);
      const distance = resolveParam(arguments[1] as NumberParam);
      const radius = resolveParam(arguments[2] as NumberParam);
      const s = new Slot(distance, radius, planeObj);
      context.addSceneObjects([new Move(start), s]);
      return s;
    }

    throw new Error("Invalid arguments for slot()");
  } as SlotFunction;
}

export default registerBuilder(build);
