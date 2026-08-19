import { SceneParserContext, registerBuilder } from "../../index.js";
import { SolvedPointRef } from "../../features/2d/solved/refs.js";
import { ISceneObject } from "../interfaces.js";
import { ConstraintTarget, emitConstraint, toRef } from "./common.js";
import type { ConstraintSpec } from "../../sketch-solver/index.js";

/**
 * Makes two points coincide (2 dims), or puts a point on an entity (1 dim:
 * point-on-infinite-line, point-on-circle/arc). `coincident(p, l.mid())`
 * lowers to the midpoint constraint.
 * @param a - A point accessor, point statement, or entity
 * @param b - A point accessor, point statement, or entity
 */
function build(context: SceneParserContext) {
  return function coincident(a: ConstraintTarget, b: ConstraintTarget): ISceneObject {
    return emitConstraint(context, 'coincident', undefined, (): ConstraintSpec => {
      const aMid = a instanceof SolvedPointRef && a.role === 'mid';
      const bMid = b instanceof SolvedPointRef && b.role === 'mid';
      if (aMid && bMid) {
        throw new Error('coincident: only one side may be a mid() reference');
      }
      if (aMid || bMid) {
        const midRef = (aMid ? a : b) as SolvedPointRef;
        const other = aMid ? b : a;
        return {
          kind: 'midpoint',
          p: toRef(other, 'coincident'),
          l: { entity: midRef.owner.entityId },
        };
      }
      return { kind: 'coincident', a: toRef(a, 'coincident'), b: toRef(b, 'coincident') };
    }, [a, b]);
  };
}

export default registerBuilder(build);
