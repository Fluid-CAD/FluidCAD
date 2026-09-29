import { SceneParserContext, registerBuilder } from "../../index.js";
import { ISceneObject } from "../interfaces.js";
import { type NumberParam, resolveParam } from "../param.js";
import { SketchDatum } from "../../features/2d/solved/datum.js";
import { ConstraintTarget, emitConstraint, requireValue, toRef } from "./common.js";
import type { ConstraintSpec, SolverRef } from "../../sketch-solver/index.js";

/**
 * Offset constraint: holds each offset entity at `distance` from its source —
 * a line parallel to its source at that distance, an arc or circle concentric
 * with its source at its radius ± distance. This is what the sketcher's
 * Offset tool writes: the offset curves are real lines and arcs you can
 * dimension and constrain further, held together by one statement. The
 * distance is positive; the side (left or right of a line, outside or inside
 * an arc) is read from where the offset entities are drawn.
 *
 * An offset entity's end that a `coincident` joins to another offset entity
 * of the same statement is a corner of the chain and slides to where the two
 * offsets meet; every other end sits straight across from its source's end,
 * so open chains end square and tangent junctions stay joined without a
 * coincident of their own. Deleting the statement leaves plain curves.
 * @param offsets - The offset entity, or the offset entities of a chain
 * @param sources - The entity each offset follows, in the same order
 * @param distance - The offset distance (positive)
 */
function build(context: SceneParserContext) {
  return function offsetFrom(
    offsets: ConstraintTarget | ConstraintTarget[],
    sources: ConstraintTarget | ConstraintTarget[],
    distance: NumberParam,
  ): ISceneObject {
    const targetList = Array.isArray(offsets) ? offsets : [offsets];
    const sourceList = Array.isArray(sources) ? sources : [sources];
    const resolved = resolveParam(distance);
    return emitConstraint(context, 'offsetFrom', resolved, (): ConstraintSpec => {
      if (targetList.length === 0) {
        throw new Error('offsetFrom: pass the offset entity (or entities) first');
      }
      if (targetList.length !== sourceList.length) {
        throw new Error(
          `offsetFrom: pairs each offset entity with one source — got ${targetList.length} offset ${targetList.length === 1 ? 'entity' : 'entities'} and ${sourceList.length} source${sourceList.length === 1 ? '' : 's'}`,
        );
      }
      const value = requireValue(resolved, 'offsetFrom');
      if (!(value > 0)) {
        throw new Error('offsetFrom: the distance must be positive — the side comes from where the offset entities are drawn');
      }
      return {
        kind: 'offset-from',
        targets: targetList.map((t, i) => entityRefOf(t, `offset entity ${i + 1}`)),
        sources: sourceList.map((s, i) => entityRefOf(s, `source ${i + 1}`)),
        value,
      };
    }, [...targetList, ...sourceList]);
  };
}

/** An entity (never a point accessor, never a datum) as a solver ref. */
function entityRefOf(arg: ConstraintTarget, what: string): SolverRef {
  if (arg instanceof SketchDatum) {
    throw new Error(`offsetFrom: ${what} is ${arg.commandName}() — offset a drawn line, arc or circle instead`);
  }
  const ref = toRef(arg, `offsetFrom ${what}`);
  if (ref.point !== undefined) {
    throw new Error(`offsetFrom: ${what} is a point — pass the line, arc or circle itself`);
  }
  return ref;
}

export default registerBuilder(build);
