import { Cylinder } from "../features/cylinder.js";
import { registerBuilder, SceneParserContext } from "../index.js";
import { ISceneObject } from "./interfaces.js";

function build(context: SceneParserContext) {
  return function cylinder(radius: number, height: number): ISceneObject {
    const cylinder = new Cylinder(radius, height);
    context.addSceneObject(cylinder);
    return cylinder;
  }
}

export default registerBuilder(build);
