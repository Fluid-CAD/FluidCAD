import { VMove } from "../../features/2d/vmove.js";
import { SceneObject } from "../../common/scene-object.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { IGeometry, ISceneObject } from "../interfaces.js";

interface VMoveFunction {
  /**
   * Moves the cursor vertically by the given distance.
   * @param distance - The vertical distance to move
   */
  (distance: number): IGeometry;
  /**
   * Moves the cursor vertically to the nearest intersection with the target geometry.
   * The nearest intersection (in either direction along the Y axis) is used.
   * @param target - The geometry to intersect with
   */
  (target: ISceneObject): IGeometry;
}

function build(context: SceneParserContext): VMoveFunction {
  return function move() {
    const arg = arguments[0];
    const distanceOrTarget: number | SceneObject = arg instanceof SceneObject
      ? arg
      : (arg as number);
    const vmove = new VMove(distanceOrTarget);
    context.addSceneObject(vmove);

    return vmove;
  } as VMoveFunction
}

export default registerBuilder(build);
