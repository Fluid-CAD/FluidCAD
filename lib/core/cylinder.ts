import { Cylinder } from "../features/cylinder.js";
import { registerBuilder, SceneParserContext } from "../index.js";
import { ITransformable } from "./interfaces.js";
import { type NumberParam, resolveParam } from "./param.js";

interface CylinderFunction {
  /**
   * Creates a cylinder with the given radius and height.
   * @param radius - The cylinder radius
   * @param height - The cylinder height
   */
  (radius: NumberParam, height: NumberParam): ITransformable;
}

function build(context: SceneParserContext): CylinderFunction {
  return function cylinder(radius: NumberParam, height: NumberParam): ITransformable {
    const cylinder = new Cylinder(resolveParam(radius), resolveParam(height));
    context.addSceneObject(cylinder);
    return cylinder;
  }
}

export default registerBuilder(build);
