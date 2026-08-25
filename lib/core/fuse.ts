import { SceneObject } from "../common/scene-object.js";
import { registerBuilder, SceneParserContext } from "../index.js";
import { Fuse } from "../features/fuse.js";
import { ISceneObject } from "./interfaces.js";

interface FuseFunction {
  /** Fuses all shapes in the current context. */
  (): Fuse;
  /**
   * Fuses the given shapes into one.
   * @param objects - The objects to fuse together
   */
  (...objects: ISceneObject[]): Fuse;
}

function build(context: SceneParserContext): FuseFunction {
  return function fuse(...args: (ISceneObject[])): ISceneObject {
    if (context.getActiveSketch()) {
      throw new Error("fuse() is no longer available inside a sketch — 2D booleans were removed");
    }

    let solids: SceneObject[];

    if (args.length === 1 && Array.isArray(args[0])) {
      solids = args[0] as SceneObject[];
    } else {
      solids = args as SceneObject[];
    }

    const fuse = new Fuse(...solids);
    context.addSceneObject(fuse);

    return fuse;
  } as FuseFunction;
}

export default registerBuilder(build);
