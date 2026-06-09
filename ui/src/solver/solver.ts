// Top-level Solver orchestrator.
//
// Each `solve()` call is pure JavaScript and synchronous. It builds the
// mate graph, runs the per-mate analytical warm-start over each spanning
// tree (BFS depth order), relaxes any closed loops / dragged chains with
// a Levenberg-Marquardt pass, then re-derives tree followers from their
// solved drivers. Per-call costs are well under 1 ms for assemblies of
// 10–50 bodies — fine for 60 fps. The solver keeps no state between
// calls; every pose is recomputed from the input.
//
// Mate dispatch is graph-aware: the mate graph is partitioned into
// connected components, and within each component a BFS spanning tree is
// built from a seed (grounded body if any, then dragged, then first by
// input order). Tree edges drive the per-mate warm-start in BFS depth
// order so chains like `A grounded → revolute → B → fastened → C`
// propagate in a single pass; closure edges are enforced by the LM pass.

import { Vector3 } from 'three';
import { buildMateGraph } from './graph.js';
import { applyLoopRelaxations } from './loop-relaxation.js';
import type { SolverInput, SolverOutput } from './types.js';
import {
  applyTreeFixups,
  applyTreeWarmStarts,
  buildFastenedClusterCache,
  countFreeBodyDof,
  countTreeFreeDof,
} from './warm-start.js';

export class Solver {
  /**
   * Solve the assembly. Synchronous and pure-JS — every pose is
   * determined by the analytical warm-start plus an LM relaxation for
   * closed loops and dragged chains.
   */
  solve(input: SolverInput): SolverOutput {
    // Partition the mate graph and pick a spanning tree per component.
    const graph = buildMateGraph(input.bodies, input.mates, input.draggedInstanceId);

    // Precompute fastened-cluster membership once per solve. Without
    // this, every non-fastened tree edge's drag helper recomputes its
    // follower's cluster by scanning the full mates list — pegging the
    // CPU when the dragged body sits inside a heavy fastened cluster.
    const fastenedClusters = buildFastenedClusterCache(input.bodies, input.mates);

    const drag = {
      draggedInstanceId: input.draggedInstanceId,
      draggedCursorWorld: input.draggedCursorWorld,
      draggedGrabLocal: input.draggedGrabLocal,
    };

    applyTreeWarmStarts(input.bodies, graph.components, input.mates, drag, fastenedClusters);

    // Loop relaxation: per-component LM pass that brings loop bodies onto
    // the closure manifold and propagates a dragged chain's IK.
    applyLoopRelaxations(input.bodies, graph.components, drag);

    const out: SolverOutput = {
      bodies: input.bodies.map(b => ({
        instanceId: b.instanceId,
        position: b.position.clone(),
        quaternion: b.quaternion.clone(),
      })),
      result: 'okay',
      // Free-body params (3 origin + 3 orientation per un-locked
      // ungrounded body) plus the geometric joint DOF the warm-start hid
      // by locking tree followers.
      dof: countFreeBodyDof(input.bodies) + countTreeFreeDof(graph.components),
      failed: [],
    };

    // Drag target: a dragged body whose position the warm-start didn't
    // pin (a free seed / driver, or a body with no mates) is translated
    // onto its drag target in the output pose. Applied to `out` (not
    // `input`) so the tree fixup below still reads each driver's frame-N
    // input pose, and before the fixup so followers carry along.
    applyDraggedOriginTarget(input, out);

    // Re-derive every tree follower from its (possibly dragged) solved
    // driver so chained mates stay consistent frame to frame.
    applyTreeFixups(graph.components, out.bodies);
    return out;
  }
}

/**
 * Translate a dragged body onto its origin target when the warm-start
 * hasn't already pinned its position — i.e. the body is a free seed /
 * driver or has no mates at all. The target is the explicit
 * `draggedTargetOrigin` when provided, else the body origin that puts the
 * grabbed point under the cursor. Mate-locked followers (lockPosition set
 * by the warm-start) are skipped — their pose comes from the warm-start /
 * LM and the post-solve tree fixup.
 */
function applyDraggedOriginTarget(input: SolverInput, out: SolverOutput): void {
  const id = input.draggedInstanceId;
  if (id === undefined) return;
  const body = input.bodies.find(b => b.instanceId === id);
  if (!body || body.grounded || body.lockPosition) return;
  const target = resolveDragTarget(input);
  if (!target) return;
  const solved = out.bodies.find(b => b.instanceId === id);
  if (solved) solved.position.copy(target);
}

/**
 * Resolve a body-origin drag target. Prefers `draggedTargetOrigin` when
 * provided (the controller's primary path); falls back to the cursor +
 * grab form, evaluated against the body's current pose.
 */
function resolveDragTarget(input: SolverInput): Vector3 | null {
  if (input.draggedTargetOrigin) return input.draggedTargetOrigin;
  if (
    input.draggedInstanceId === undefined
    || input.draggedCursorWorld === undefined
    || input.draggedGrabLocal === undefined
  ) {
    return null;
  }
  const body = input.bodies.find(b => b.instanceId === input.draggedInstanceId);
  if (!body) return null;
  const grabRotated = input.draggedGrabLocal.clone().applyQuaternion(body.quaternion);
  return input.draggedCursorWorld.clone().sub(grabRotated);
}

/** Convenience: returns true if a SolverOutput should leave poses applied. */
export function isUsableSolution(out: SolverOutput): boolean {
  return out.result === 'okay';
}
