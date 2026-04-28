import { HMove } from "../../features/2d/hmove.js";
import { SceneObject } from "../../common/scene-object.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { IGeometry, ISceneObject } from "../interfaces.js";

interface HMoveFunction {
  /**
   * Moves the cursor horizontally by the given distance.
   * @param distance - The horizontal distance to move
   */
  (distance: number): IGeometry;
  /**
   * Moves the cursor horizontally to the nearest intersection with the target geometry.
   * The nearest intersection (in either direction along the X axis) is used.
   * @param target - The geometry to intersect with
   */
  (target: ISceneObject): IGeometry;
}

function build(context: SceneParserContext): HMoveFunction {
  return function move() {
    const arg = arguments[0];
    const distanceOrTarget: number | SceneObject = arg instanceof SceneObject
      ? arg
      : (arg as number);
    const hmove = new HMove(distanceOrTarget);
    context.addSceneObject(hmove);

    return hmove;
  } as HMoveFunction
}

export default registerBuilder(build);
