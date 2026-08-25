import { SceneObject } from "../common/scene-object.js";
import { registerBuilder, SceneParserContext } from "../index.js";
import { Common } from "../features/common.js";
import { ICommon, ISceneObject } from "./interfaces.js";

interface CommonFunction {
  /** Computes the common (intersection) of all shapes in the current context. */
  (): ICommon;
  /**
   * Computes the common (intersection) of the given shapes.
   * @param objects - The objects to intersect
   */
  (...objects: ISceneObject[]): ICommon;
}

function build(context: SceneParserContext): CommonFunction {
  return function common(...args: (ISceneObject[])): ISceneObject {
    if (context.getActiveSketch()) {
      throw new Error("common() is no longer available inside a sketch — 2D booleans were removed");
    }

    let solids: SceneObject[];

    if (args.length === 1 && Array.isArray(args[0])) {
      solids = args[0] as SceneObject[];
    } else {
      solids = args as SceneObject[];
    }

    const common = new Common(...solids);
    context.addSceneObject(common);

    return common;
  } as CommonFunction;
}

export default registerBuilder(build);
