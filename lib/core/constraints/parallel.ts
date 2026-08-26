import { SceneParserContext, registerBuilder } from "../../index.js";
import { ISceneObject } from "../interfaces.js";
import { ConstraintTarget, emitConstraint, toRef } from "./common.js";
import type { ConstraintSpec } from "../../sketch-solver/index.js";

/**
 * Constrains two or more lines to be parallel (1 dim per pair). Every line
 * after the first is paralleled to the first.
 * @param a - The reference line
 * @param b - The second line
 * @param rest - Further lines to parallel to the first
 */
function build(context: SceneParserContext) {
  return function parallel(
    a: ConstraintTarget,
    b: ConstraintTarget,
    ...rest: ConstraintTarget[]
  ): ISceneObject {
    const targets = [a, b, ...rest];
    return emitConstraint(context, 'parallel', undefined, (): ConstraintSpec => ({
      kind: 'parallel',
      a: toRef(a, 'parallel'),
      b: toRef(b, 'parallel'),
      ...(rest.length > 0 ? { others: rest.map(t => toRef(t, 'parallel')) } : {}),
    }), targets);
  };
}

export default registerBuilder(build);
