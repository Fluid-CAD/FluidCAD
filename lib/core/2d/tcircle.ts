import { SceneObject } from "../../common/scene-object.js";
import { QualifiedGeometry } from "../../features/2d/constraints/qualified-geometry.js";
import { TangentCircle2Tan } from "../../features/2d/tcircle-two-tan.js";
import { TangentCircle3Tan } from "../../features/2d/tcircle-three-tan.js";
import { registerBuilder, SceneParserContext } from "../../index.js";

interface TCircleFunction {
  (c1: SceneObject | QualifiedGeometry, c2: SceneObject | QualifiedGeometry, radius: number): TangentCircle2Tan;
  (c1: SceneObject | QualifiedGeometry, c2: SceneObject | QualifiedGeometry, c3: SceneObject | QualifiedGeometry): TangentCircle3Tan;
}

function build(context: SceneParserContext): TCircleFunction {
  return function tCircle() {
    if (arguments.length === 3 && typeof arguments[2] === 'number') {
      const c1 = QualifiedGeometry.from(arguments[0]);
      const c2 = QualifiedGeometry.from(arguments[1]);
      const radius: number = arguments[2];

      const tangentCircle = new TangentCircle2Tan(c1, c2, radius);
      context.addSceneObject(tangentCircle);
      return tangentCircle;
    } else if (arguments.length === 3) {
      const c1 = QualifiedGeometry.from(arguments[0]);
      const c2 = QualifiedGeometry.from(arguments[1]);
      const c3 = QualifiedGeometry.from(arguments[2]);

      const tangentCircle = new TangentCircle3Tan(c1, c2, c3);
      context.addSceneObject(tangentCircle);
      return tangentCircle;
    } else {
      throw new Error('Invalid arguments for tCircle: expected (c1, c2, radius) or (c1, c2, c3)');
    }
  } as TCircleFunction;
}

export default registerBuilder(build);
