import { SceneObject } from "../common/scene-object.js";
import { registerBuilder, SceneParserContext } from "../index.js";
import { Fuse } from "../features/fuse.js";
import { ISceneObject } from "./interfaces.js";

interface FuseFunction {
  /** Fuses all solids in the current context; surfaces are left alone. */
  (): Fuse;
  /**
   * Fuses the given solids into one.
   * @param objects - The objects to fuse together — solids; an object that stands for a surface and no solid is refused
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
