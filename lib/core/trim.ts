import { Point2DLike } from "../math/point.js";
import { normalizePoint2D } from "../helpers/normalize.js";
import { registerBuilder, SceneParserContext } from "../index.js";
import { Trim2D } from "../features/trim2d.js";
import { ISceneObject } from "./interfaces.js";

function build(context: SceneParserContext) {
  return function trim(...args: Point2DLike[]): ISceneObject {
    const activeSketch = context.getActiveSketch();

    if (!activeSketch) {
      throw new Error("Trim can only be used within a sketch");
    }

    const trim2d = new Trim2D();
    if (args.length > 0) {
      trim2d.points(...args.map(p => normalizePoint2D(p)));
    }

    context.addSceneObject(trim2d);
    return trim2d;
  }
}

export default registerBuilder(build);
