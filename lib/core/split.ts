import { SceneObject } from "../common/scene-object.js";
import { GeometrySceneObject } from "../features/2d/geometry.js";
import { registerBuilder, SceneParserContext } from "../index.js";
import { Split2D } from "../features/split2d.js";
import { ISceneObject } from "./interfaces.js";

function build(context: SceneParserContext) {
  return function split(...args: (ISceneObject[])): ISceneObject {
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

      const split2d = new Split2D(...objects);
      context.addSceneObject(split2d);
      return split2d;
    }

    throw new Error("Split can only be used within a sketch");
  }
}

export default registerBuilder(build);
