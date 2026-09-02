import { SceneParserContext, registerBuilder } from "../../index.js";
import { SketchDatum } from "../../features/2d/solved/datum.js";
import { ISceneObject } from "../interfaces.js";
import { ConstraintTarget, emitConstraint, toRef } from "./common.js";
import type { ConstraintSpec, SolverRef } from "../../sketch-solver/index.js";

function sameRef(a: SolverRef, b: SolverRef): boolean {
  return a.entity === b.entity && (a.point ?? null) === (b.point ?? null);
}

function refuseAxis(arg: ConstraintTarget, slot: string): void {
  if (arg instanceof SketchDatum && arg.isAxis) {
    throw new Error(`midpoint: ${arg.commandName} is an infinite axis — it is not a point (${slot})`);
  }
}

/**
 * Constrains point p to be the midpoint of line l — or, with three
 * arguments, to sit halfway between points a and b (2 dims either way).
 * @param p - The point
 * @param l - The line whose midpoint p takes; with b given, the first of the two points
 * @param b - The second point, for the point-pair form `midpoint(p, a, b)`
 */
function build(context: SceneParserContext) {
  return function midpoint(p: ConstraintTarget, l: ConstraintTarget, b?: ConstraintTarget): ISceneObject {
    if (b === undefined) {
      return emitConstraint(context, 'midpoint', undefined, (): ConstraintSpec => {
        if (l instanceof SketchDatum && l.isAxis) {
          throw new Error(`midpoint: ${l.commandName} is an infinite axis — its midpoint is undefined`);
        }
        return {
          kind: 'midpoint',
          p: toRef(p, 'midpoint'),
          l: toRef(l, 'midpoint'),
        };
      }, [p, l]);
    }
    const a = l;
    return emitConstraint(context, 'midpoint', undefined, (): ConstraintSpec => {
      refuseAxis(p, 'the midpoint');
      refuseAxis(a, 'first point');
      refuseAxis(b, 'second point');
      const pRef = toRef(p, 'midpoint');
      const aRef = toRef(a, 'midpoint');
      const bRef = toRef(b, 'midpoint');
      if (sameRef(aRef, bRef)) {
        throw new Error('midpoint: the two points are the same point — pick two distinct points');
      }
      if (sameRef(pRef, aRef) || sameRef(pRef, bRef)) {
        throw new Error('midpoint: the midpoint is one of the two points — that would force them together');
      }
      return { kind: 'midpoint', p: pRef, a: aRef, b: bRef };
    }, [p, a, b]);
  };
}

export default registerBuilder(build);
