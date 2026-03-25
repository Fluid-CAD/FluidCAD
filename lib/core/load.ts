import { registerBuilder, SceneParserContext } from "../index.js";
import { LoadFile } from "../features/load.js";
import { ISceneObject } from "./interfaces.js";

interface LoadFunction {
  (fileName: string): ISceneObject;
}

function build(context: SceneParserContext): LoadFunction {
  return function load() {
    const obj = new LoadFile(arguments[0]);
    context.addSceneObject(obj);
    return obj;
  }
}

export default registerBuilder(build);
