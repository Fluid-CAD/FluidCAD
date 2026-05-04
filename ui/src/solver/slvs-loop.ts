// Scaffolding for a "let slvs handle planar closures natively" path
// that didn't pan out. Kept around because the underlying machinery
// (per-component classification, mate-id emit set threaded through
// `CompileCtx.slvsEmitMates`, lock-skip in warm-start, LM bypass) all
// works correctly for the cases where slvs's projected equation
// matches reality. The reason it's gated off is purely a constraint-
// math limitation of slvs's POINT_IN_2D entity:
//
//   - Connectors have a local Z component; POINT_IN_2D drops it.
//   - For two same-orientation bodies, the dropped offsets are equal
//     on both sides of POINTS_COINCIDENT and cancel exactly — slvs's
//     equation matches reality.
//   - For face-to-face mating (the default in revolute / slider /
//     planar), one body is flipped 180° around an XY axis, which
//     negates the dropped offset on that side. The equations no
//     longer cancel; slvs converges to a config with a real-world
//     Z gap of `2·max(localOrigin.z)` mm.
//
// Almost every CAD assembly uses face-to-face mating with non-zero
// connector Z (top-face connectors on extruded parts), so the slvs
// path is not useful for the common case. The JS-side LM in
// `loop-relaxation.ts` handles closures correctly across all cases —
// the trick was setting `CLOSURE_DRAG_WEIGHT = 0` so the LM doesn't
// trade closure for drag fit.

import type { Component } from './graph.js';
import type { BodyState } from './types.js';

/**
 * Always returns false — see file-level comment for why the slvs-
 * solvable path is gated off. Left as an explicit predicate so a
 * future revisit (e.g., a constraint set that doesn't depend on
 * POINT_IN_2D) can re-enable per case.
 */
export function isComponentSlvsSolvable(
  _component: Component,
  _bodyById: Map<string, BodyState>,
): boolean {
  return false;
}

export type SlvsLoopClassification = {
  /** Body instance ids whose params should NOT be locked at the slvs level. */
  loopBodies: Set<string>;
  /** Mate ids whose compiler should emit real slvs constraints. */
  emitMates: Set<string>;
  /** Component indices that should skip the JS-side LM pass. */
  componentIndices: Set<number>;
};

/**
 * Walk every component and decide which qualify for the slvs path.
 * Currently a no-op (returns empty sets) because
 * `isComponentSlvsSolvable` is gated off; the orchestrator in
 * `solver.ts` still threads the empty sets through so the wiring is
 * a one-line flip away if the slvs path becomes useful.
 */
export function classifySlvsSolvable(
  components: Component[],
  bodies: BodyState[],
): SlvsLoopClassification {
  const bodyById = new Map(bodies.map(b => [b.instanceId, b]));
  const loopBodies = new Set<string>();
  const emitMates = new Set<string>();
  const componentIndices = new Set<number>();

  components.forEach((component, idx) => {
    if (!isComponentSlvsSolvable(component, bodyById)) return;
    componentIndices.add(idx);
    for (const id of component.loopBodies) loopBodies.add(id);
    for (const edge of component.treeEdges) {
      if (
        component.loopBodies.has(edge.parent.instanceId)
        && component.loopBodies.has(edge.child.instanceId)
      ) {
        emitMates.add(edge.mate.mateId);
      }
    }
    for (const closure of component.closureEdges) emitMates.add(closure.mateId);
  });

  return { loopBodies, emitMates, componentIndices };
}
