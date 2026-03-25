import { Sphere } from "../features/sphere.js";
import { rad } from "../helpers/math-helpers.js";
import { registerBuilder, SceneParserContext } from "../index.js";
import { ISceneObject } from "./interfaces.js";

function build(context: SceneParserContext) {
  return function sphere(radius: number, angle: number = 360): ISceneObject {
    const sphere = new Sphere(radius, rad(angle));
    context.addSceneObject(sphere);
    return sphere;
  }
}

export default registerBuilder(build);
