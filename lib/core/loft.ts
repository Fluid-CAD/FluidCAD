import { SceneObject } from "../common/scene-object.js";
import { registerBuilder, SceneParserContext } from "../index.js";
import { Loft } from "../features/loft.js";
import { ILoft, ISceneObject } from "./interfaces.js";

interface LoftFunction {
  /**
   * Creates a loft between two or more profiles.
   * @param profiles - The profiles to loft between (minimum 2)
   */
  (...profiles: ISceneObject[]): ILoft;
}

function build(context: SceneParserContext): LoftFunction {
  return function loft(...args: SceneObject[]): Loft {
    let faces: SceneObject[];

    if (args.length === 1 && Array.isArray(args[0])) {
      faces = args[0];
    } else {
      faces = args;
    }

    if (faces.length < 2) {
      throw new Error("Loft requires at least two profiles.");
    }

    context.addSceneObjects(faces);
    const result = new Loft(...faces);
    context.addSceneObject(result);
    return result;
  }
}

export default registerBuilder(build);
