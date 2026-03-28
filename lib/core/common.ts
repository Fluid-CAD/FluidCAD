import { SceneObject } from "../common/scene-object.js";
import { GeometrySceneObject } from "../features/2d/geometry.js";
import { registerBuilder, SceneParserContext } from "../index.js";
import { Common } from "../features/common.js";
import { Common2D } from "../features/common2d.js";
import { ICommon, ISceneObject } from "./interfaces.js";

interface CommonFunction {
  /** Computes the common (intersection) of all shapes or 2D geometries in the current context. */
  (): ICommon;
  /**
   * Computes the common (intersection) of the given shapes or 2D geometries.
   * @param objects - The objects to intersect
   */
  (...objects: ISceneObject[]): ICommon;
}

function build(context: SceneParserContext): CommonFunction {
  return function common(...args: (ISceneObject[])): ISceneObject {
    const activeSketch = context.getActiveSketch();

    if (activeSketch) {
      let objects: GeometrySceneObject[];
      if (args.length > 0) {
        if (args.length === 1 && Array.isArray(args[0])) {
          objects = args[0] as GeometrySceneObject[];
        } else {
          objects = args as GeometrySceneObject[];
        }
      } else {
        objects = [];
      }
      const common2d = new Common2D(...objects);
      context.addSceneObject(common2d);
      return common2d;
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
