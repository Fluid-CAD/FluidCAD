import { Point2DLike } from "../math/point.js";
import { normalizePoint2D } from "../helpers/normalize.js";
import { registerBuilder, SceneParserContext } from "../index.js";
import { Trim2D } from "../features/trim2d.js";
import { EdgeTargetArg } from "../features/2d/geometry.js";
import { EdgeFilterBuilder } from "../filters/edge/edge-filter.js";
import { ISceneObject } from "./interfaces.js";
import { addTargetObjects } from "./target-utils.js";

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
   * Removes the edges matching the given targets. Geometry and accessor
   * targets remove whole edges; edge filters are matched against the
   * sketch's split segments (geometry split at mutual intersections) and
   * remove the matching segments.
   * @param targets - Geometries, edge accessors (`r.edge('top')`), or edge
   *   filters (`edge().line()`) selecting the edges to remove
   */
  (...targets: (ISceneObject | EdgeFilterBuilder)[]): ITrim;
}

function build(context: SceneParserContext): TrimFunction {
  return function trim(...args: EdgeTargetArg[]): ITrim {
    const activeSketch = context.getActiveSketch();

    if (!activeSketch) {
      throw new Error("Trim can only be used within a sketch");
    }

    const trim2d = new Trim2D();
    if (args.length > 0) {
      addTargetObjects(args, context);
      trim2d.setTargets(...args);
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
