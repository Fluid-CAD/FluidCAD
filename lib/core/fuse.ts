import { SceneObject } from "../common/scene-object.js";
import { GeometrySceneObject } from "../features/2d/geometry.js";
import { registerBuilder, SceneParserContext } from "../index.js";
import { Fuse } from "../features/fuse.js";
import { Fuse2D } from "../features/fuse2d.js";
import { ISceneObject } from "./interfaces.js";
import { addTargetObjects, sketchLastSelection } from "./target-utils.js";

interface FuseFunction {
  /** Fuses all shapes or 2D geometries in the current context. */
  (): Fuse | Fuse2D;
  /**
   * Fuses the given shapes or 2D geometries into one.
   * @param objects - The objects to fuse together
   */
  (...objects: ISceneObject[]): Fuse | Fuse2D;
}

function build(context: SceneParserContext): FuseFunction {
  return function fuse(...args: (ISceneObject[])): ISceneObject {
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
        objects = sketchLastSelection(context, activeSketch) as unknown as GeometrySceneObject[];
      }
      addTargetObjects(objects, context);
      const fuse2d = new Fuse2D(...objects);
      context.addSceneObject(fuse2d);
      return fuse2d;
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
