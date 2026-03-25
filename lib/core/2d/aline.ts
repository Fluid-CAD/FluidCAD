import { AngledLine } from "../../features/2d/aline.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { PlaneObjectBase } from "../../features/plane-renderable-base.js";
import { isPlaneLike, PlaneLike } from "../../math/plane.js";
import { SceneObject } from "../../common/scene-object.js";
import { resolvePlane } from "../../helpers/resolve.js";
import { IGeometry, ISceneObject } from "../interfaces.js";

interface ALineFunction {
  /**
   * Draws a line at the given angle with the given length.
   * @param length - The line length
   * @param angle - The angle in degrees
   * @param centered - Whether to center the line on the current position
   */
  (length: number, angle: number, centered?: boolean): IGeometry;
  /**
   * Draws a line at the given angle on a specific plane.
   * @param length - The line length
   * @param angle - The angle in degrees
   * @param targetPlane - The plane to draw on
   */
  (length: number, angle: number, targetPlane: PlaneLike | ISceneObject): IGeometry;
  /**
   * Draws a centered line at the given angle on a specific plane.
   * @param length - The line length
   * @param angle - The angle in degrees
   * @param centered - Whether to center the line on the current position
   * @param targetPlane - The plane to draw on
   */
  (length: number, angle: number, centered: boolean, targetPlane: PlaneLike | ISceneObject): IGeometry;
}

function build(context: SceneParserContext): ALineFunction {
  return function line() {
    let planeObj: PlaneObjectBase | null = null;
    let argCount = arguments.length;

    // Detect plane as last argument
    if (argCount > 0) {
      const lastArg = arguments[argCount - 1];
      if (isPlaneLike(lastArg) || lastArg instanceof SceneObject) {
        planeObj = resolvePlane(lastArg, context);
        argCount--;
      }
    }

    const length: number = arguments[0];
    const angle: number = arguments[1];
    const centered = argCount >= 3 ? (arguments[2] as boolean) : false;

    const aline = new AngledLine(length, angle, centered, planeObj);
    context.addSceneObject(aline);

    return aline;
  }
}

export default registerBuilder(build);
