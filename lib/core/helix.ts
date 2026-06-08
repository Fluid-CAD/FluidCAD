import { registerBuilder, SceneParserContext } from "../index.js";
import { Helix } from "../features/helix.js";
import { AxisLike, isAxisLike } from "../math/axis.js";
import { AxisObject } from "../features/axis.js";
import { AxisObjectBase } from "../features/axis-renderable-base.js";
import { SceneObject } from "../common/scene-object.js";
import { normalizeAxis } from "../helpers/normalize.js";
import { IHelix, ISceneObject } from "./interfaces.js";

interface HelixFunction {
  /**
   * Creates a helix wire along the given axis. Use chained methods (.pitch(),
   * .turns(), .height(), .radius(), .endRadius()) to configure geometry.
   * @param axis - The axis to build the helix around.
   */
  (axis: AxisLike): IHelix;

  /**
   * Creates a helix wire derived from a scene object's geometry.
   * - A cylindrical or conical face: axis + radii + height come from the face.
   * - A line edge: axis = the line, height = line length.
   * - A circular edge: axis = circle normal at center, radius = circle radius.
   * @param source - The scene object whose face/edge defines the helix.
   */
  (source: ISceneObject): IHelix;
}

function build(context: SceneParserContext): HelixFunction {
  return function helix() {
    if (arguments.length === 0) {
      throw new Error("helix() requires an axis or scene object argument.");
    }

    const arg = arguments[0];
    let source: AxisObjectBase | SceneObject;

    if (arg instanceof AxisObjectBase) {
      source = arg;
      context.addSceneObject(source);
    } else if (isAxisLike(arg)) {
      const axis = normalizeAxis(arg);
      source = new AxisObject(axis);
      context.addSceneObject(source);
    } else if (arg instanceof SceneObject) {
      source = arg;
      context.addSceneObject(source);
    } else {
      throw new Error("helix(): first argument must be an AxisLike or SceneObject.");
    }

    const result = new Helix(source);
    context.addSceneObject(result);
    return result;
  } as HelixFunction;
}

export default registerBuilder(build);
