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
// connected components, and within each component a BFS spanning forest
// is built from the roots (ALL grounded bodies; else the dragged body,
// else the first by input order). Tree edges drive the per-mate
// warm-start in BFS depth order so chains like
// `A grounded → revolute → B → fastened → C` propagate in a single
// pass; closure edges are enforced by the LM pass.

import { Vector3 } from 'three';
import { buildMateGraph, type MateGraph } from './graph.js';
import { residual } from './joint-model.js';
import { applyLoopRelaxations } from './loop-relaxation.js';
import type { BodyState, SolverInput, SolverOutput } from './types.js';
import {
  applyTreeFixups,
  applyTreeWarmStarts,
  buildFastenedClusterCache,
  countFreeBodyDof,
  countTreeFreeDof,
} from './warm-start.js';

// Post-solve consistency threshold on each mate's residual ∞-norm.
// Deliberately loose so the joints-panel red dots don't flicker per
// pixel of drag: during a partially-radial drag on a closed loop, the
// LM's small drag weight legitimately leaves closure gaps up to
// ~0.1 mm (the rhombus regression's own acceptance bound), so the
// threshold sits just above that equilibrium. Anything past it is a
// genuine closure gap (unreachable geometry, conflicting grounds)
// rather than drag compromise. Translation rows are mm; revisit after
// stage D's joint-space LM tightens the during-drag equilibrium.
const FAILED_MATE_EPS = 0.1;

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
    // the closure manifold and propagates a dragged chain's IK. Returns
    // each closure component's loop DOF (joint variables minus the rank
    // of the closure Jacobian at the solution).
    const loopDof = applyLoopRelaxations(input.bodies, graph.components, drag);

    // DOF accounting, per component: closure components use the
    // rank-based loop DOF (a 4-bar reads 1, not 3 — its closure eats
    // two of the three joint variables); everything else sums the free
    // body params (3 origin + 3 orientation per un-locked ungrounded
    // body) plus the geometric joint DOF the warm-start hid by locking
    // tree followers.
    let dof = 0;
    graph.components.forEach((component, i) => {
      const ld = loopDof[i];
      if (ld !== null) {
        dof += ld;
      } else {
        dof += countFreeBodyDof(component.bodies) + countTreeFreeDof([component]);
      }
    });

    const out: SolverOutput = {
      bodies: input.bodies.map(b => ({
        instanceId: b.instanceId,
        position: b.position.clone(),
        quaternion: b.quaternion.clone(),
      })),
      result: 'okay',
      dof,
      failed: [],
    };

    // Drag target: a dragged body whose position the warm-start didn't
    // pin (a free seed / driver, or a body with no mates) is translated
    // onto its drag target in the output pose. Applied to `out` (not
    // `input`) so the tree fixup below still reads each driver's frame-N
    // input pose, and before the fixup so followers carry along.
    applyDraggedOriginTarget(input, out);

    // Dragging a LOCKED body of an ungrounded, closure-free component
    // (a fastened sibling, a chain follower) translates the whole tree
    // rigidly so the grab lands on the cursor — the LM deliberately
    // skips these (see loop-relaxation.ts) because the drag rows alone
    // under-determine a free root's 6 DOF.
    applyUngroundedClusterDrag(input, out, graph);

    // Re-derive every tree follower from its (possibly dragged) solved
    // driver so chained mates stay consistent frame to frame.
    applyTreeFixups(graph.components, out.bodies);

    // Consistency report: evaluate EVERY mate's residual (tree, closure,
    // both-grounded) at the final output poses. Solved poses stay
    // applied either way — an inconsistent assembly still shows its
    // least-bad configuration; the report drives the DOF pill and the
    // joints-panel red dots.
    out.failed = collectFailedMates(input, out);
    out.result = out.failed.length > 0 ? 'inconsistent' : 'okay';
    return out;
  }
}

/**
 * Mate ids whose residual ∞-norm at the OUTPUT poses exceeds
 * FAILED_MATE_EPS. Mates referencing missing bodies/connectors are
 * skipped (they never reached the solver; an upstream layer reports
 * them). Mate types without a residual implementation are skipped too —
 * they're rejected at parse time.
 */
function collectFailedMates(input: SolverInput, out: SolverOutput): string[] {
  const inputById = new Map(input.bodies.map(b => [b.instanceId, b]));
  const solvedById = new Map(out.bodies.map(b => [b.instanceId, b]));
  const failed: string[] = [];
  for (const mate of input.mates) {
    const aIn = inputById.get(mate.connectorA.instanceId);
    const bIn = inputById.get(mate.connectorB.instanceId);
    if (!aIn || !bIn) continue;
    const aConn = aIn.connectors.find(c => c.connectorId === mate.connectorA.connectorId);
    const bConn = bIn.connectors.find(c => c.connectorId === mate.connectorB.connectorId);
    if (!aConn || !bConn) continue;
    const aSolved = solvedById.get(aIn.instanceId);
    const bSolved = solvedById.get(bIn.instanceId);
    if (!aSolved || !bSolved) continue;
    const a: BodyState = { ...aIn, position: aSolved.position, quaternion: aSolved.quaternion };
    const b: BodyState = { ...bIn, position: bSolved.position, quaternion: bSolved.quaternion };
    const r = residual(mate.type, a, aConn, b, bConn, mate.options ?? {});
    let maxAbs = 0;
    for (const v of r) {
      maxAbs = Math.max(maxAbs, Math.abs(v));
    }
    if (maxAbs > FAILED_MATE_EPS) failed.push(mate.mateId);
  }
  return failed;
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
 * Rigid whole-tree translation for drags of LOCKED bodies in an
 * ungrounded, closure-free component: translate the component's root so
 * the dragged body's grab point lands on the cursor. Tree relations are
 * translation-invariant, so the post-solve fixups carry every follower
 * along and the joint state (angles, slides) is untouched — the
 * warm-start already applied any analytic joint drag delta, and this
 * closes only the remaining rigid gap. Unlocked dragged bodies (free
 * bodies, ungrounded roots) are handled by `applyDraggedOriginTarget`.
 */
function applyUngroundedClusterDrag(
  input: SolverInput,
  out: SolverOutput,
  graph: MateGraph,
): void {
  const id = input.draggedInstanceId;
  if (id === undefined) return;
  if (!input.draggedCursorWorld || !input.draggedGrabLocal) return;
  const body = input.bodies.find(b => b.instanceId === id);
  if (!body || body.grounded || !body.lockPosition) return;
  const componentIndex = graph.bodyComponent.get(id);
  if (componentIndex === undefined) return;
  const component = graph.components[componentIndex];
  if (component.closureEdges.length > 0) return;
  if (component.roots.length !== 1 || component.roots[0].grounded) return;
  const rootOut = out.bodies.find(b => b.instanceId === component.roots[0].instanceId);
  const draggedOut = out.bodies.find(b => b.instanceId === id);
  if (!rootOut || !draggedOut) return;
  const grabWorld = input.draggedGrabLocal.clone()
    .applyQuaternion(draggedOut.quaternion)
    .add(draggedOut.position);
  rootOut.position.add(input.draggedCursorWorld.clone().sub(grabWorld));
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

/**
 * Strict check: true only when every mate is satisfied. Note the
 * controller applies poses on 'inconsistent' too (an assembly with a
 * genuine closure gap still shows its least-bad configuration); this
 * stays for callers that want an all-satisfied guarantee.
 */
export function isUsableSolution(out: SolverOutput): boolean {
  return out.result === 'okay';
}
