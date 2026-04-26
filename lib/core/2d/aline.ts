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
   * @param targetPlane - The plane to draw on
   * @param length - The line length
   * @param angle - The angle in degrees
   */
  (targetPlane: PlaneLike | ISceneObject, length: number, angle: number): IGeometry;
  /**
   * Draws a centered line at the given angle on a specific plane.
   * @param targetPlane - The plane to draw on
   * @param length - The line length
   * @param angle - The angle in degrees
   * @param centered - Whether to center the line on the current position
   */
  (targetPlane: PlaneLike | ISceneObject, length: number, angle: number, centered: boolean): IGeometry;
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

    const argCount = arguments.length - argOffset;
    const length: number = arguments[argOffset];
    const angle: number = arguments[argOffset + 1];
    const centered = argCount >= 3 ? (arguments[argOffset + 2] as boolean) : false;

    const aline = new AngledLine(length, angle, centered, planeObj);
    context.addSceneObject(aline);

    return aline;
  }
}

export default registerBuilder(build);
