import { PolarMove } from "../../features/2d/pmove.js";
import { SceneObject } from "../../common/scene-object.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { IGeometry, ISceneObject } from "../interfaces.js";

interface PolarMoveFunction {
  /**
   * Moves the cursor by polar coordinates, relative to the current tangent.
   * The angle is measured from the tangent of the previous geometry (defaults to +X
   * when there is none).
   * @param radius - The distance to move
   * @param angle - The angle in degrees, relative to the current tangent
   */
  (radius: number, angle: number): IGeometry;
  /**
   * Moves the cursor along the given angle (relative to the current tangent) to the
   * nearest intersection with the target geometry. The nearest intersection (in either
   * direction along the ray) is used.
   * @param target - The geometry to intersect with
   * @param angle - The angle in degrees, relative to the current tangent
   */
  (target: ISceneObject, angle: number): IGeometry;
}

function build(context: SceneParserContext): PolarMoveFunction {
  return function pmove() {
    const arg0 = arguments[0];
    const angle = (arguments[1] as number) * Math.PI / 180;
    const radiusOrTarget: number | SceneObject = arg0 instanceof SceneObject
      ? arg0
      : (arg0 as number);
    const pmove = new PolarMove(radiusOrTarget, angle);
    context.addSceneObject(pmove);

    return pmove;
  } as PolarMoveFunction
}

export default registerBuilder(build);
