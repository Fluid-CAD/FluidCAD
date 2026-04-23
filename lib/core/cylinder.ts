import { Cylinder } from "../features/cylinder.js";
import { registerBuilder, SceneParserContext } from "../index.js";
import { ITransformable } from "./interfaces.js";

interface CylinderFunction {
  /**
   * Creates a cylinder with the given radius and height.
   * @param radius - The cylinder radius
   * @param height - The cylinder height
   */
  (radius: number, height: number): ITransformable;
}

function build(context: SceneParserContext): CylinderFunction {
  return function cylinder(radius: number, height: number): ITransformable {
    const cylinder = new Cylinder(radius, height);
    context.addSceneObject(cylinder);
    return cylinder;
  }
}

export default registerBuilder(build);
