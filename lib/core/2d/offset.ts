import { Offset } from "../../features/2d/offset.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { IOffset } from "../interfaces.js";
import { type NumberParam, type BooleanParam, isNumberParam, isBooleanParam, resolveParam } from "../param.js";

interface OffsetFunction {
  /**
   * Offsets the current sketch geometry by the given distance.
   * @param distance - The offset distance (defaults to 1)
   * @param removeOriginal - Whether to remove the original geometry
   */
  (distance?: NumberParam, removeOriginal?: BooleanParam): IOffset;
}

function build(context: SceneParserContext): OffsetFunction {
  return function offset(...args: any[]) {
    const distance = isNumberParam(args[0]) ? resolveParam(args[0] as NumberParam) : 1;
    const removeOriginal = isBooleanParam(args[1]) ? resolveParam(args[1] as BooleanParam) : false;
    const off = new Offset(distance, removeOriginal);
    context.addSceneObject(off);
    return off;
  } as OffsetFunction;
}

export default registerBuilder(build);
