import { SceneObject } from "../../common/scene-object.js";
import { QualifiedSceneObject } from "../../features/2d/constraints/qualified-geometry.js";
import { OneObjectTangentLine, TwoObjectsTangentLine } from "../../features/2d/tline-constrained.js";
import { TangentLine } from "../../features/2d/tline.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { IGeometry, ISceneObject, ITwoObjectsTangentLine } from "../interfaces.js";

interface TLineFunction {
  (distance: number): IGeometry;
  (c1: ISceneObject | QualifiedSceneObject, c2: ISceneObject | QualifiedSceneObject, mustTouch?: boolean): ITwoObjectsTangentLine;
  (c1: ISceneObject | QualifiedSceneObject, mustTouch?: boolean): IGeometry;
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
