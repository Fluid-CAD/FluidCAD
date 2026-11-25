import { SceneParserContext, registerBuilder } from "../../index.js";
import { SketchDatum } from "../../features/2d/solved/datum.js";
import { ISceneObject } from "../interfaces.js";
import { ConstraintTarget, emitConstraint, toRef } from "./common.js";
import type { ConstraintSpec } from "../../sketch-solver/index.js";

/**
 * Constrains two or more entities to be equal: equal line lengths or equal
 * circle/arc radii (1 dim per pair), or the same shape for ellipses and
 * elliptical arcs (2 dims per pair: both semi-radii). Every entity after
 * the first is equated to the first.
 * @param a - The reference entity
 * @param b - The second entity
 * @param rest - Further entities to equate to the first
 */
function build(context: SceneParserContext) {
  return function equal(
    a: ConstraintTarget,
    b: ConstraintTarget,
    ...rest: ConstraintTarget[]
  ): ISceneObject {
    const targets = [a, b, ...rest];
    return emitConstraint(context, 'equal', undefined, (): ConstraintSpec => {
      for (const t of targets) {
        if (t instanceof SketchDatum && t.isAxis) {
          throw new Error(`equal: ${t.commandName} is an infinite axis — it has no length to equate`);
        }
      }
      return {
        kind: 'equal',
        a: toRef(a, 'equal'),
        b: toRef(b, 'equal'),
        ...(rest.length > 0 ? { others: rest.map(t => toRef(t, 'equal')) } : {}),
      };
    }, targets);
  };
}

export default registerBuilder(build);
