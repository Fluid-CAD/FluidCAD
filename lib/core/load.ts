import { registerBuilder, SceneParserContext } from "../index.js";
import { LoadFile } from "../features/load.js";
import { ILoadFile, LoadOptions } from "./interfaces.js";

interface LoadFunction {
  /**
   * Loads an imported model (the cached STEP import in `imports/`) by name.
   *
   * The model brings the file's solids, its surfaces (faces that enclose
   * no volume, connected or on their own) and its curves (edges that bound
   * no face), with the face colours of solids and surfaces. `.include(i)` and `.exclude(i)` count
   * them in that order: every solid first, then every surface, then every
   * curve. `load()` reads the cache the import wrote; a cache that holds
   * only solids gains the file's surfaces and curves when the file is
   * imported again.
   *
   * Imports are cached in mm and scaled into this document's unit
   * automatically, so a unit is normally unnecessary. `options.unit` asserts
   * the unit the asset's cached geometry is in, for assets without
   * trustworthy metadata; it overrides the import sidecar.
   *
   * In an installed package's file, `load()` reads the package's own
   * `imports/`, which it ships. `options.from: 'project'` reads the
   * project's instead, for a name the model using the package passes in.
   * @param fileName - The asset name (the STEP file name without extension)
   * @param options - Optional `{ unit }` assertion of the asset's unit, and
   *   `{ from: 'project' }` to read the project's `imports/` from package code
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
