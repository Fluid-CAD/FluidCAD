import { registerBuilder, SceneParserContext } from "../index.js";
import { LoadFile } from "../features/load.js";
import { ISceneObject, ITransformable } from "./interfaces.js";

interface LoadFunction {
  /**
   * Loads a 3D model file (STEP, STL, etc.) by filename.
   * @param fileName - The path to the model file
   */
  (fileName: string): ITransformable;
}

function build(context: SceneParserContext): LoadFunction {
  return function load() {
    const obj = new LoadFile(arguments[0]);
    context.addSceneObject(obj);
    return obj;
  }
}

export default registerBuilder(build);
