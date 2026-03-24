import { SceneObject } from "../common/scene-object.js";
import { GeometrySceneObject } from "../features/2d/geometry.js";
import { registerBuilder, SceneParserContext } from "../index.js";
import { Fuse } from "../features/fuse.js";
import { Fuse2D } from "../features/fuse2d.js";

function build(context: SceneParserContext) {
  return function fuse(...args: (SceneObject[])): Fuse | Fuse2D {
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
      const fuse2d = new Fuse2D(...objects);
      context.addSceneObject(fuse2d);
      return fuse2d;
    }

    let solids: SceneObject[];

    if (args.length === 1 && Array.isArray(args[0])) {
      solids = args[0];
    } else {
      solids = args;
    }

    const fuse = new Fuse(...solids);
    context.addSceneObject(fuse);

    return fuse;
  }
}

export default registerBuilder(build);
