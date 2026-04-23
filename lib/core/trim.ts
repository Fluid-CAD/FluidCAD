import { Point2DLike } from "../math/point.js";
import { normalizePoint2D } from "../helpers/normalize.js";
import { registerBuilder, SceneParserContext } from "../index.js";
import { Trim2D } from "../features/trim2d.js";
import { EdgeFilterBuilder } from "../filters/edge/edge-filter.js";

interface ITrim {
  /**
   * Enters interactive trimming mode, optionally trimming edges at the given points.
   * @param points - Points where geometry should be trimmed; the nearest edge segment to each point is removed.
   */
  pick(...points: Point2DLike[]): ITrim;
}

interface TrimFunction {
  /** Trims all sketch geometry segments. */
  (): ITrim;
  /**
   * Trims sketch geometry segments matching the given edge filters.
   * @param filters - Edge filters that select which edges to remove
   */
  (...filters: EdgeFilterBuilder[]): ITrim;
}

function build(context: SceneParserContext): TrimFunction {
  return function trim(...args: EdgeFilterBuilder[]): ITrim {
    const activeSketch = context.getActiveSketch();

    if (!activeSketch) {
      throw new Error("Trim can only be used within a sketch");
    }

    const trim2d = new Trim2D();
    if (args.length > 0) {
      trim2d.setFilters(...args);
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
