import { SceneObject } from "../../common/scene-object.js";
import { QualifiedGeometry } from "../../features/2d/constraints/qualified-geometry.js";
import { OneCircleTangentLine, TwoCirclesTangentLine } from "../../features/2d/tline-constrained.js";
import { TangentLine } from "../../features/2d/tline.js";
import { registerBuilder, SceneParserContext } from "../../index.js";

interface TLineFunction {
  (distance: number): TangentLine;
  (c1: SceneObject | QualifiedGeometry, c2: SceneObject | QualifiedGeometry): TwoCirclesTangentLine;
  (c1: SceneObject | QualifiedGeometry): OneCircleTangentLine;
}

function build(context: SceneParserContext): TLineFunction {
  return function line() {
    if (arguments.length === 1 && typeof arguments[0] === 'number') {
      const distance: number = arguments[0];
      const hline = new TangentLine(distance);
      context.addSceneObject(hline);
      return hline;
    }
    else if (arguments.length === 1) {
      const constrainedLine = new OneCircleTangentLine(QualifiedGeometry.from(arguments[0]));
      context.addSceneObject(constrainedLine);
      return constrainedLine;
    }
    else if (arguments.length === 2 || arguments.length === 3) {
      const constrainedLine = new TwoCirclesTangentLine(
        QualifiedGeometry.from(arguments[0]),
        QualifiedGeometry.from(arguments[1])
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
