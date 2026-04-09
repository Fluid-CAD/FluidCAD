import { SceneObject } from "../common/scene-object.js";
import { registerBuilder, SceneParserContext } from "../index.js";
import { Sweep } from "../features/sweep.js";
import { Extrudable } from "../helpers/types.js";
import { ISweep, ISceneObject } from "./interfaces.js";

interface SweepFunction {
  /**
   * Sweeps the last sketch along a path.
   * @param path - The path to sweep along (edges/wire)
   */
  (path: ISceneObject): ISweep;

  /**
   * Sweeps the given sketch along a path.
   * @param path - The path to sweep along (edges/wire)
   * @param target - The sketch to sweep
   */
  (path: ISceneObject, target?: ISceneObject): ISweep;
}

function isExtrudable(obj: any): obj is Extrudable {
  return obj instanceof SceneObject && obj.isExtrudable();
}

function build(context: SceneParserContext): SweepFunction {

  //@ts-ignore
  return function sweep() {
    const args = [...arguments];

    if (args.length === 0) {
      throw new Error("sweep() requires at least a path argument.");
    }

    // Last argument may be the target extrudable
    let extrudable: Extrudable | undefined;
    if (args.length > 1 && isExtrudable(args[args.length - 1])) {
      extrudable = args.pop() as Extrudable;
    } else {
      extrudable = context.getLastExtrudable() || undefined;
    }

    const path = args[0] as SceneObject;

    context.addSceneObject(path);
    const result = new Sweep(path, extrudable);
    context.addSceneObject(result);
    return result;
  } as SweepFunction;
}

export default registerBuilder(build);
