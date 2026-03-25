import { Point2D, Point2DLike } from "../../math/point.js";
import { RMove } from "../../features/2d/rmove.js";
import { normalizePoint2D } from "../../helpers/normalize.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { IGeometry } from "../interfaces.js";

interface RMoveFunction {
  /**
   * Rotates the cursor direction by the given angle in degrees.
   * @param angle - The rotation angle in degrees
   */
  (angle: number): IGeometry;
  /**
   * Rotates the cursor direction by the given angle around a pivot point.
   * @param angle - The rotation angle in degrees
   * @param pivot - The pivot point to rotate around
   */
  (angle: number, pivot: Point2DLike): IGeometry;
}

function build(context: SceneParserContext): RMoveFunction {
  return function rmove() {
    const angle = (arguments[0] as number) * Math.PI / 180;
    const pivot = normalizePoint2D(arguments[1] || new Point2D(0, 0))
    const rmove = new RMove(pivot, angle)
    context.addSceneObject(rmove);

    return rmove;
  }
}

export default registerBuilder(build);
