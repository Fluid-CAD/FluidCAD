import { Sphere } from "../features/sphere.js";
import { rad } from "../helpers/math-helpers.js";
import { registerBuilder, SceneParserContext } from "../index.js";
import { ITransformable } from "./interfaces.js";
import { type NumberParam, resolveParam } from "./param.js";

interface SphereFunction {
  /**
   * Creates a full sphere with the given radius.
   * @param radius - The sphere radius
   */
  (radius: NumberParam): ITransformable;
  /**
   * Creates a partial sphere with the given radius and sweep angle.
   * @param radius - The sphere radius
   * @param angle - The sweep angle in degrees
   */
  (radius: NumberParam, angle: NumberParam): ITransformable;
}

function build(context: SceneParserContext): SphereFunction {
  return function sphere(radius: NumberParam, angle: NumberParam = 360): ITransformable {
    const sphere = new Sphere(resolveParam(radius), rad(resolveParam(angle)));
    context.addSceneObject(sphere);
    return sphere;
  } as SphereFunction;
}

export default registerBuilder(build);
