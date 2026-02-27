import { SceneObject } from "../../common/scene-object.js";
import { QualifiedGeometry } from "../../features/2d/constraints/qualified-geometry.js";
import { TangentCircle2Tan, TangentCircle3Tan } from "../../features/2d/tcircle-constrained.js";
import { registerBuilder, SceneParserContext } from "../../index.js";

interface TCircleFunction {
  (c1: SceneObject | QualifiedGeometry, c2: SceneObject | QualifiedGeometry, radius: number): TangentCircle2Tan;
  (c1: SceneObject | QualifiedGeometry, c2: SceneObject | QualifiedGeometry, c3: SceneObject | QualifiedGeometry): TangentCircle3Tan;
}

function toQualified(arg: SceneObject | QualifiedGeometry): QualifiedGeometry {
  if (arg instanceof QualifiedGeometry) {
    return arg;
  }
  return new QualifiedGeometry(arg, 'unqualified');
}

function build(context: SceneParserContext): TCircleFunction {
  return function tCircle() {
    if (arguments.length === 3 && typeof arguments[2] === 'number') {
      const c1 = toQualified(arguments[0]);
      const c2 = toQualified(arguments[1]);
      const radius: number = arguments[2];

      const tangentCircle = new TangentCircle2Tan(c1, c2, radius);
      context.addSceneObject(tangentCircle);
      return tangentCircle;
    } else if (arguments.length === 3) {
      const c1 = toQualified(arguments[0]);
      const c2 = toQualified(arguments[1]);
      const c3 = toQualified(arguments[2]);

      const tangentCircle = new TangentCircle3Tan(c1, c2, c3);
      context.addSceneObject(tangentCircle);
      return tangentCircle;
    } else {
      throw new Error('Invalid arguments for tCircle: expected (c1, c2, radius) or (c1, c2, c3)');
    }
  } as TCircleFunction;
}

export default registerBuilder(build);
