import { SceneObject } from "../common/scene-object.js";
import { GeometrySceneObject } from "../features/2d/geometry.js";
import { registerBuilder, SceneParserContext } from "../index.js";
import { Fuse } from "../features/fuse.js";
import { Fuse2D } from "../features/fuse2d.js";

function build(context: SceneParserContext) {
  return function fuse(...args: (SceneObject[])): Fuse | Fuse2D {
    const activeSketch = context.getActiveSketch();

    if (activeSketch) {
      const fuse2d = new Fuse2D();
      if (args.length > 0) {
        let objects: SceneObject[];
        if (args.length === 1 && Array.isArray(args[0])) {
          objects = args[0];
        } else {
          objects = args;
        }
        fuse2d.target(...(objects as GeometrySceneObject[]));
      }
      context.addSceneObject(fuse2d);
      return fuse2d;
    }

    let solids: SceneObject[];

    if (args.length === 1 && Array.isArray(args[0])) {
      solids = args[0];
    } else {
      solids = args;
    }

    const fuse = new Fuse();
    if (solids.length > 0) {
      fuse.target(...solids);
    }
    context.addSceneObject(fuse);

    return fuse;
  }
}

export default registerBuilder(build);
