import { PolarMove } from "../../features/2d/pmove.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { IGeometry } from "../interfaces.js";

interface PolarMoveFunction {
  /**
   * Moves the cursor by polar coordinates.
   * @param radius - The distance to move
   * @param angle - The angle in degrees
   */
  (radius: number, angle: number): IGeometry;
}

function build(context: SceneParserContext): PolarMoveFunction {
  return function pmove() {
    const radius = arguments[0] as number;
    const angle = (arguments[1] as number) * Math.PI / 180;
    const pmove = new PolarMove(radius, angle);
    context.addSceneObject(pmove);

    return pmove;
  }
}

export default registerBuilder(build);
