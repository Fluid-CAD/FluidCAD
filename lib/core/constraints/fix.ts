import { SceneParserContext, registerBuilder } from "../../index.js";
import { Point2DLike } from "../../math/point.js";
import { normalizePoint2D } from "../../helpers/normalize.js";
import { ISceneObject } from "../interfaces.js";
import { ConstraintTarget, emitConstraint, toRef } from "./common.js";
import type { ConstraintSpec } from "../../sketch-solver/index.js";

/**
 * Anchors a point in place (2 dims). Without an explicit position the
 * point's current (guess) coordinates are captured at statement time.
 * @param p - The point to anchor
 * @param position - Optional explicit [x, y] anchor position
 */
function build(context: SceneParserContext) {
  return function fix(p: ConstraintTarget, position?: Point2DLike): ISceneObject {
    return emitConstraint(context, 'fix', undefined, (): ConstraintSpec => {
      const spec: Extract<ConstraintSpec, { kind: 'fix' }> = { kind: 'fix', p: toRef(p, 'fix') };
      if (position !== undefined) {
        const pos = normalizePoint2D(position).asPoint2D();
        spec.x = pos.x;
        spec.y = pos.y;
      }
      return spec;
    }, [p]);
  };
}

export default registerBuilder(build);
