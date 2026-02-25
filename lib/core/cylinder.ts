import { Cylinder } from "../features/cylinder.js";
import { registerBuilder, SceneParserContext } from "../index.js";

function build(context: SceneParserContext) {
  return function cylinder(radius: number, height: number) {
    const cylinder = new Cylinder(radius, height);
    context.addSceneObject(cylinder);
    return cylinder;
  }
}

export default registerBuilder(build);
