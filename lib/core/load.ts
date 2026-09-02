import { registerBuilder, SceneParserContext } from "../index.js";
import { LoadFile } from "../features/load.js";
import { ILoadFile, LoadOptions } from "./interfaces.js";

interface LoadFunction {
  /**
   * Loads an imported model (the cached STEP import in `imports/`) by name.
   *
   * Imports are cached in mm and scaled into this document's unit
   * automatically, so a unit is normally unnecessary. `options.unit` asserts
   * the unit the asset's cached geometry is in, for assets without
   * trustworthy metadata; it overrides the import sidecar.
   * @param fileName - The asset name (the STEP file name without extension)
   * @param options - Optional `{ unit }` assertion of the asset's unit
   */
  (fileName: string, options?: LoadOptions): ILoadFile;
}

function build(context: SceneParserContext): LoadFunction {
  return function load() {
    const obj = new LoadFile(arguments[0], arguments[1]);
    context.addSceneObject(obj);
    return obj;
  }
}

export default registerBuilder(build);
