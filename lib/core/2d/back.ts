import { Back } from "../../features/2d/back.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { IGeometry } from "../interfaces.js";

interface BackFunction {
  /** Reverts the cursor to the previous position. */
  (): IGeometry;
  /**
   * Reverts the cursor `count` position-changes back.
   * @param count - How many prior cursor changes to undo (default 1).
   */
  (count: number): IGeometry;
}

function build(context: SceneParserContext): BackFunction {
  return function back() {
    const count = (arguments[0] as number | undefined) ?? 1;
    const obj = new Back(count);
    context.addSceneObject(obj);
    return obj;
  }
}

export default registerBuilder(build);
