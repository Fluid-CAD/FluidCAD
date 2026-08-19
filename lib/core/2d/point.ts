import { Point2DLike } from "../../math/point.js";
import { SolvedPoint } from "../../features/2d/solved/point.js";
import { normalizePoint2D } from "../../helpers/normalize.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { IGeometry } from "../interfaces.js";

interface PointFunction {
  /**
   * Places a solver point at the given position. Constraint sketches only —
   * the position is a guess like every other literal; constrain it with
   * coincident/fix/distance statements.
   * @param position - The point position
   */
  (position: Point2DLike): IGeometry;
}

function build(context: SceneParserContext): PointFunction {
  return function point(position: Point2DLike): IGeometry {
    const pos = normalizePoint2D(position).asPoint2D();
    const obj = new SolvedPoint(pos);
    context.addSceneObject(obj);

    const activeSketch = context.getActiveSketch();
    if (activeSketch && activeSketch.isSolvedMode()) {
      obj.register(activeSketch);
    }
    return obj;
  } as PointFunction;
}

export default registerBuilder(build);
