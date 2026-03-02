import { SceneObject } from "../../common/scene-object.js";
import { QualifiedGeometry } from "../../features/2d/constraints/qualified-geometry.js";
import { TwoCirclesTangentLine } from "../../features/2d/tline-constrained.js";
import { TangentLine } from "../../features/2d/tline.js";
import { registerBuilder, SceneParserContext } from "../../index.js";

interface TLineFunction {
  (distance: number): TangentLine;
  (c1: SceneObject | QualifiedGeometry, c2: SceneObject | QualifiedGeometry): TwoCirclesTangentLine;
  (c1: SceneObject | QualifiedGeometry): TwoCirclesTangentLine;
}

function build(context: SceneParserContext): TLineFunction {
  return function line() {
    if (arguments.length === 1) {
      const distance: number = arguments[0];
      const hline = new TangentLine(distance);
      context.addSceneObject(hline);
      return hline;
    }
    else if (arguments.length === 2 || arguments.length === 3) {
      let c1: QualifiedGeometry;
      let c2: QualifiedGeometry;

      if (arguments[0] instanceof QualifiedGeometry) {
        c1 = arguments[0];
      }
      else {
        c1 = new QualifiedGeometry(arguments[0], 'unqualified');
      }

      if (arguments[1] instanceof QualifiedGeometry) {
        c2 = arguments[1];
      }
      else {
        c2 = new QualifiedGeometry(arguments[1], 'unqualified');
      }

      const constrainedLine = new TwoCirclesTangentLine(c1, c2);
      context.addSceneObject(constrainedLine);
      return constrainedLine;
    }
    else {
      throw new Error('Invalid number of arguments for line function');
    }
  } as TLineFunction;
}

export default registerBuilder(build);
