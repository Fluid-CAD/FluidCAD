import { PlaneCenter } from "../../features/2d/plane-center.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { IGeometry } from "../interfaces.js";

interface CenterFunction {
  /**
   * Move the current position to the center of the sketch plane.
   */
  (): IGeometry;
}

function build(context: SceneParserContext): CenterFunction {
  return function center() {
    const planeCenter = new PlaneCenter();
    context.addSceneObject(planeCenter);
    return planeCenter;
  }
}

export default registerBuilder(build);
