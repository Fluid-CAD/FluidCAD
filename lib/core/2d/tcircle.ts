import { SceneObject } from "../../common/scene-object.js";
import { Vertex } from "../../common/vertex.js";
import { QualifiedSceneObject } from "../../features/2d/constraints/qualified-geometry.js";
import { TwoObjectsTangentCircle } from "../../features/2d/tcircle-constrained.js";
import { normalizePoint2D } from "../../helpers/normalize.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { isPoint2DLike, Point2DLike } from "../../math/point.js";
import { IGeometry, ISceneObject } from "../interfaces.js";

interface TCircleFunction {
  /**
   * Draws a circle tangent to two objects with the given diameter.
   * @param c1 - The first constraint object or point
   * @param c2 - The second constraint object or point
   * @param diameter - The circle diameter
   * @param mustTouch - Whether the circle must touch both objects
   */
  (c1: ISceneObject | QualifiedSceneObject | Point2DLike, c2: ISceneObject | QualifiedSceneObject | Point2DLike, diameter: number, mustTouch?: boolean): IGeometry;
}

function build(context: SceneParserContext): TCircleFunction {
  return function tCircle() {
    if ((arguments.length === 3 || arguments.length === 4) && typeof arguments[2] === 'number') {
      const o1 = isPoint2DLike(arguments[0]) ? normalizePoint2D(arguments[0] as Point2DLike) : arguments[0]
      const o2 = isPoint2DLike(arguments[1]) ? normalizePoint2D(arguments[1] as Point2DLike) : arguments[1]
      const c1 = QualifiedSceneObject.from(o1);
      const c2 = QualifiedSceneObject.from(o2);
      const diameter: number = arguments[2];
      const mustTouch = typeof arguments[3] === 'boolean' ? arguments[3] : false;

      const tangentCircle = new TwoObjectsTangentCircle(c1, c2, diameter, mustTouch);
      context.addSceneObject(tangentCircle);
      return tangentCircle;
    }
    else {
      throw new Error('Invalid arguments for tCircle: expected (c1, c2, diameter) or (c1, c2, c3)');
    }
  } as TCircleFunction;
}

export default registerBuilder(build);
