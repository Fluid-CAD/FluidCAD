import { SceneObject } from "../../common/scene-object.js";
import { Vertex } from "../../common/vertex.js";
import { QualifiedSceneObject } from "../../features/2d/constraints/qualified-geometry.js";
import { TwoObjectsTangentCircle } from "../../features/2d/tcircle-constrained.js";
import { normalizePoint2D } from "../../helpers/normalize.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { isPoint2DLike, Point2DLike } from "../../math/point.js";

interface TCircleFunction {
  (c1: SceneObject | QualifiedSceneObject | Point2DLike, c2: SceneObject | QualifiedSceneObject | Point2DLike, radius: number): TwoObjectsTangentCircle;
}

function build(context: SceneParserContext): TCircleFunction {
  return function tCircle() {
    if (arguments.length === 3 && typeof arguments[2] === 'number') {
      const o1 = isPoint2DLike(arguments[0]) ? normalizePoint2D(arguments[0] as Point2DLike) : arguments[0]
      const o2 = isPoint2DLike(arguments[1]) ? normalizePoint2D(arguments[1] as Point2DLike) : arguments[1]
      const c1 = QualifiedSceneObject.from(o1);
      const c2 = QualifiedSceneObject.from(o2);
      const radius: number = arguments[2];

      const tangentCircle = new TwoObjectsTangentCircle(c1, c2, radius);
      context.addSceneObject(tangentCircle);
      return tangentCircle;
    }
    else {
      throw new Error('Invalid arguments for tCircle: expected (c1, c2, radius) or (c1, c2, c3)');
    }
  } as TCircleFunction;
}

export default registerBuilder(build);
