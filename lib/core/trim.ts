import { Point2DLike } from "../math/point.js";
import { normalizePoint2D } from "../helpers/normalize.js";
import { registerBuilder, SceneParserContext } from "../index.js";
import { Trim2D } from "../features/trim2d.js";

interface ITrim {
  pick(...points: Point2DLike[]): ITrim;
}

interface TrimFunction {
  /** Trims all sketch geometry segments. */
  (): ITrim;
  /**
   * Trims sketch geometry segments at the given points.
   * @param points - The points where geometry should be trimmed
   */
  (...points: Point2DLike[]): ITrim;
}

function build(context: SceneParserContext): TrimFunction {
  return function trim(...args: Point2DLike[]): ITrim {
    const activeSketch = context.getActiveSketch();

    if (!activeSketch) {
      throw new Error("Trim can only be used within a sketch");
    }

    const trim2d = new Trim2D();
    if (args.length > 0) {
      trim2d.points(...args.map(p => normalizePoint2D(p)));
    }

    context.addSceneObject(trim2d);

    return {
      pick(...points: Point2DLike[]): ITrim {
        trim2d.pick(...points.map(p => normalizePoint2D(p)));
        return this;
      },
    };
  } as TrimFunction;
}

export default registerBuilder(build);
