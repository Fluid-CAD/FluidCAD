import { AngledLine } from "../../features/2d/aline.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { PlaneObjectBase } from "../../features/plane-renderable-base.js";
import { isPlaneLike, PlaneLike } from "../../math/plane.js";
import { SceneObject } from "../../common/scene-object.js";
import { resolvePlane } from "../../helpers/resolve.js";
import { IALine, ISceneObject } from "../interfaces.js";

interface ALineFunction {
  /**
   * Draws a line at the given angle with the given length.
   * Chain `.centered()` to center the line on the current position.
   * @param angle - The angle in degrees
   * @param length - The line length
   */
  (angle: number, length: number): IALine;
  /**
   * Draws a line at the given angle on a specific plane.
   * @param targetPlane - The plane to draw on
   * @param angle - The angle in degrees
   * @param length - The line length
   */
  (targetPlane: PlaneLike | ISceneObject, angle: number, length: number): IALine;
}

function build(context: SceneParserContext): ALineFunction {
  return function line() {
    let planeObj: PlaneObjectBase | null = null;
    let argOffset = 0;

    // Detect plane as first argument (only valid outside a sketch)
    if (arguments.length > 0) {
      const firstArg = arguments[0];
      if (isPlaneLike(firstArg) || firstArg instanceof SceneObject) {
        if (context.getActiveSketch() !== null) {
          throw new Error("aLine(plane, ...) cannot be used inside a sketch. Use aLine(...) instead.");
        }
        planeObj = resolvePlane(firstArg, context);
        argOffset = 1;
      }
    }

    const angle: number = arguments[argOffset];
    const length: number = arguments[argOffset + 1];

    const aline = new AngledLine(angle, length, planeObj);
    context.addSceneObject(aline);

    return aline;
  }
}

export default registerBuilder(build);
