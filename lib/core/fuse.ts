import { SceneObject } from "../common/scene-object.js";
import { registerBuilder, SceneParserContext } from "../index.js";
import { Fuse } from "../features/fuse.js";

function build(context: SceneParserContext) {
  return function fuse(...args: (SceneObject[])): Fuse {
    let solids: SceneObject[];

    if (args.length === 1 && Array.isArray(args[0])) {
      solids = args[0];
    } else {
      solids = args;
    }

    const fuse = new Fuse(solids);
    context.addSceneObject(fuse);

    return fuse;
  }
}

export default registerBuilder(build);
