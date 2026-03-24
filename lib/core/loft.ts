import { SceneObject } from "../common/scene-object.js";
import { registerBuilder, SceneParserContext } from "../index.js";
import { Loft } from "../features/loft.js";

interface LoftFunction {
  (...faces: SceneObject[]): Loft;
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

    const result = new Loft(...faces);
    context.addSceneObject(result);
    return result;
  }
}

export default registerBuilder(build);
