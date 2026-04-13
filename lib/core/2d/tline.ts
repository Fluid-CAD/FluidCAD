import { SceneObject } from "../../common/scene-object.js";
import { QualifiedSceneObject } from "../../features/2d/constraints/qualified-geometry.js";
import { OneObjectTangentLine, TwoObjectsTangentLine } from "../../features/2d/tline-constrained.js";
import { TangentLine } from "../../features/2d/tline.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { IGeometry, ISceneObject, ITwoObjectsTangentLine } from "../interfaces.js";

interface TLineFunction {
  /**
   * Draws a line tangent to the previous geometry with the given distance.
   * @param distance - The tangent line length
   */
  (distance: number): IGeometry;
  /**
   * Draws a line tangent to two geometry objects.
   * @param c1 - The first geometry object
   * @param c2 - The second geometry object
   * @param mustTouch - Whether the line must touch both objects
   */
  (c1: ISceneObject, c2: ISceneObject, mustTouch?: boolean): ITwoObjectsTangentLine;
  /**
   * Draws a line tangent to two qualified geometry objects.
   * @param c1 - The first qualified geometry object (e.g., `outside(circle1)`)
   * @param c2 - The second qualified geometry object
   * @param mustTouch - Whether the line must touch both objects
   */
  (c1: QualifiedSceneObject, c2: QualifiedSceneObject, mustTouch?: boolean): ITwoObjectsTangentLine;
  /**
   * Draws a line tangent to a combination of geometry and qualified geometry objects.
   * @param c1 - The first constraint (geometry or qualified geometry)
   * @param c2 - The second constraint (geometry or qualified geometry)
   * @param mustTouch - Whether the line must touch both objects
   */
  (c1: ISceneObject | QualifiedSceneObject, c2: ISceneObject | QualifiedSceneObject, mustTouch?: boolean): ITwoObjectsTangentLine;
  /**
   * Draws a line tangent to one geometry object.
   * @param c1 - The geometry object to be tangent to
   * @param mustTouch - Whether the line must touch the object
   */
  (c1: ISceneObject, mustTouch?: boolean): IGeometry;
  /**
   * Draws a line tangent to a qualified geometry object.
   * @param c1 - The qualified geometry object (e.g., `outside(circle1)`)
   * @param mustTouch - Whether the line must touch the object
   */
  (c1: QualifiedSceneObject, mustTouch?: boolean): IGeometry;
}

function build(context: SceneParserContext): TLineFunction {
  return function line() {
    if (arguments.length === 1 && typeof arguments[0] === 'number') {
      const distance: number = arguments[0];
      const hline = new TangentLine(distance);
      context.addSceneObject(hline);
      return hline;
    }
    else if (arguments.length === 1 || (arguments.length === 2 && typeof arguments[1] === 'boolean')) {
      const mustTouch = typeof arguments[1] === 'boolean' ? arguments[1] : false;
      const constrainedLine = new OneObjectTangentLine(QualifiedSceneObject.from(arguments[0]), mustTouch);
      context.addSceneObject(constrainedLine);
      return constrainedLine;
    }
    else if (arguments.length >= 2) {
      const mustTouch = typeof arguments[2] === 'boolean' ? arguments[2] : false;
      const constrainedLine = new TwoObjectsTangentLine(
        QualifiedSceneObject.from(arguments[0]),
        QualifiedSceneObject.from(arguments[1]),
        mustTouch
      );
      context.addSceneObject(constrainedLine);
      return constrainedLine;
    }
    else {
      throw new Error('Invalid number of arguments for line function');
    }
  } as TLineFunction;
}

export default registerBuilder(build);
