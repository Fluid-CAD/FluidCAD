import { Sphere } from "../features/sphere.js";
import { rad } from "../helpers/math-helpers.js";
import { registerBuilder, SceneParserContext } from "../index.js";
import { ISceneObject } from "./interfaces.js";

interface SphereFunction {
  /**
   * Creates a full sphere with the given radius.
   * @param radius - The sphere radius
   */
  (radius: number): ISceneObject;
  /**
   * Creates a partial sphere with the given radius and sweep angle.
   * @param radius - The sphere radius
   * @param angle - The sweep angle in degrees
   */
  (radius: number, angle: number): ISceneObject;
}

function build(context: SceneParserContext): SphereFunction {
  return function sphere(radius: number, angle: number = 360): ISceneObject {
    const sphere = new Sphere(radius, rad(angle));
    context.addSceneObject(sphere);
    return sphere;
  } as SphereFunction;
}

export default registerBuilder(build);
