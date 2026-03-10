import { SceneObject } from "../../common/scene-object.js";
import { QualifiedSceneObject } from "../../features/2d/constraints/qualified-geometry.js";
import { OneObjectTangentLine, TwoObjectsTangentLine } from "../../features/2d/tline-constrained.js";
import { TangentLine } from "../../features/2d/tline.js";
import { registerBuilder, SceneParserContext } from "../../index.js";

interface TLineFunction {
  (distance: number): TangentLine;
  (c1: SceneObject | QualifiedSceneObject, c2: SceneObject | QualifiedSceneObject): TwoObjectsTangentLine;
  (c1: SceneObject | QualifiedSceneObject): OneObjectTangentLine;
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
      const constrainedLine = new OneObjectTangentLine(QualifiedSceneObject.from(arguments[0]));
      context.addSceneObject(constrainedLine);
      return constrainedLine;
    }
    else if (arguments.length === 2 || arguments.length === 3) {
      const constrainedLine = new TwoObjectsTangentLine(
        QualifiedSceneObject.from(arguments[0]),
        QualifiedSceneObject.from(arguments[1])
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
