import { Point2DLike, isPoint2DLike } from "../../math/point.js";
import { Move } from "../../features/2d/move.js";
import { Slot } from "../../features/2d/slot.js";
import { SlotFromEdge } from "../../features/2d/slot-from-edge.js";
import { GeometrySceneObject } from "../../features/2d/geometry.js";
import { normalizePoint2D } from "../../helpers/normalize.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { SceneObject } from "../../common/scene-object.js";
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
}

function build(context: SceneParserContext): SlotFunction {
  return function slot() {
    // SlotFromEdge path: first arg is a SceneObject (geometry)
    if (arguments[0] instanceof SceneObject && !isPoint2DLike(arguments[0])) {
      const geometry = arguments[0] as GeometrySceneObject;
      const radius = resolveParam(arguments[1] as NumberParam);
      let deleteSource = true;
      if (arguments.length > 2 && isBooleanParam(arguments[2])) {
        deleteSource = resolveParam(arguments[2] as BooleanParam);
      }

      const slotFromEdge = new SlotFromEdge(geometry, radius, deleteSource, null);
      context.addSceneObject(slotFromEdge);
      return slotFromEdge;
    }

    const argCount = arguments.length;

    // slot(distance, radius)
    if (argCount === 2 && isNumberParam(arguments[0])) {
      const distance = resolveParam(arguments[0] as NumberParam);
      const radius = resolveParam(arguments[1] as NumberParam);
      const s = new Slot(distance, radius, null);
      context.addSceneObject(s);
      return s;
    }

    // slot(start, end, radius)
    if (argCount === 3
      && isPoint2DLike(arguments[0]) && isPoint2DLike(arguments[1])) {
      const start = normalizePoint2D(arguments[0]);
      const end = normalizePoint2D(arguments[1]);
      const radius = arguments[2] as number;
      const s = Slot.fromTwoPoints(start, end, radius, null);
      context.addSceneObjects([new Move(start), s]);
      return s;
    }

    // slot(start, distance, radius)
    if (argCount === 3) {
      const start = normalizePoint2D(arguments[0]);
      const distance = resolveParam(arguments[1] as NumberParam);
      const radius = resolveParam(arguments[2] as NumberParam);
      const s = new Slot(distance, radius, null);
      context.addSceneObjects([new Move(start), s]);
      return s;
    }

    throw new Error("Invalid arguments for slot()");
  } as SlotFunction;
}

export default registerBuilder(build);
