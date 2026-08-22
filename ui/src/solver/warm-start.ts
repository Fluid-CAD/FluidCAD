// Tree warm-start + post-solve fixup, dispatched in BFS spanning-forest
// order over the mate graph. This analytical pass IS the solver for the
// spanning forest: each tree mate's follower pose is computed in closed
// form (via the generic joint model in joint-model.ts) rather than
// handed to an iterative constraint solver.
//
//   1. **Warm-start** (`seedTreeEdge`): given a tree edge
//      `parent→child`, decide the joint params (preserve the measured
//      free params when the frame-N snapshot had the mate satisfied,
//      else reseed from the mate options), add the drag delta, clamp
//      limits, and write the child's full target pose via `pose()`.
//      Set `lockPosition` and `lockOrientation` on the child so its
//      pose is taken as fully determined — not a free DOF — which
//      keeps the DOF count correct (a grounded driver + fastened
//      follower → 0 DOF).
//
//   2. **Fixup** (`fixupTreeEdge`): after a drag / LM pass has moved
//      the driver, re-extract the joint params from the post-solve
//      body pair and re-derive the child's pose from the *solved*
//      parent pose, so the relation holds exactly every frame.
//
// Driver/follower is fixed by graph topology: for a tree edge
// `parent → child`, parent is the driver and child is the follower.
// The graph builder picks the roots (ALL grounded bodies; else the
// dragged body, else the first by input order) and orders edges by BFS
// depth, so chains like `A grounded → revolute → B → fastened → C`
// propagate correctly in a single pass without role-replay logic.
//
// Closed loops aren't covered by the spanning-forest warm-start:
// closure mates are skipped here and enforced by the LM relaxation
// pass in `loop-relaxation.ts`.

import { Quaternion, Vector3 } from 'three';
import type { Component, TreeEdge } from './graph.js';
import {
  JOINT_SPECS,
  clampParamsToLimits,
  defaultParams,
  defaultParamsReversed,
  dragDelta,
  extract,
  hasFreeParams,
  isSatisfied,
  mergeParams,
  mergeParamsReversed,
  observedFlip,
  pose,
  reversedLimits,
  type FastenedClusterCache,
  type JointParams,
  type MateOptions,
  type TreeDragInfo,
} from './joint-model.js';
import type { BodyState, ConnectorState, MateRecord, SolvedBody } from './types.js';

// Kernel + cluster helpers live in joint-model.ts; re-exported here so
// existing import sites (solver.ts, residuals.ts) stay unchanged.
export {
  buildFastenedClusterCache,
  computeFastenedTargetPose,
  type FastenedClusterCache,
  type TreeDragInfo,
} from './joint-model.js';

/**
 * Walk every component's tree edges in BFS order, applying the generic
 * joint-model warm-start to each. After this returns, every follower
 * body in a tree edge has `lockPosition + lockOrientation` set, so its
 * pose is taken as fully determined (not a free DOF).
 *
 * Closure edges are skipped — they're enforced by the LM relaxation
 * pass in `loop-relaxation.ts`.
 */
export function applyTreeWarmStarts(
  bodies: BodyState[],
  components: Component[],
  mates: MateRecord[],
  drag: TreeDragInfo = {},
  clusters?: FastenedClusterCache,
): void {
  const bodyById = new Map(bodies.map(b => [b.instanceId, b]));
  // Snapshot the input poses so per-edge warm-starts can decide
  // "fresh assembly" (reseed) vs "drag in progress" (preserve) by
  // checking whether the mate was satisfied at frame N — before any
  // warm-start in this pass mutated the driver's pose. Without this,
  // a drag step that moves the driver inevitably violates the
  // current-state mate satisfaction by the cursor delta, which the
  // old check interpreted as "fresh, reseed", wiping out the
  // follower's accumulated free-DOF rotation.
  const prevPoses = new Map<string, { position: Vector3; quaternion: Quaternion }>();
  for (const b of bodies) {
    prevPoses.set(b.instanceId, {
      position: b.position.clone(),
      quaternion: b.quaternion.clone(),
    });
  }
  for (const component of components) {
    for (const edge of component.treeEdges) {
      seedTreeEdge(edge, mates, drag, bodyById, prevPoses, clusters);
    }
  }
}

/**
 * Re-derive every tree-edge follower from the SOLVED driver pose.
 * Runs in BFS forward order so chained mates propagate: edge 1's
 * fixup updates the second body, then edge 2's fixup reads that
 * second body as its driver.
 */
export function applyTreeFixups(
  components: Component[],
  out: SolvedBody[],
): void {
  const outById = new Map(out.map(b => [b.instanceId, b]));
  for (const component of components) {
    for (const edge of component.treeEdges) {
      fixupTreeEdge(edge, outById);
    }
  }
}

type PrevPoses = Map<string, { position: Vector3; quaternion: Quaternion }>;

/**
 * Returns a `BodyState` whose position and quaternion are the snapshot
 * values from frame N (before any warm-start mutation in this pass).
 * Used by the seed path to evaluate "was the mate satisfied at the
 * start of this solve?" without being misled by upstream warm-start
 * mutations that already happened in this pass.
 *
 * Returns null if no snapshot exists (shouldn't happen in normal
 * flow, but keeps callers safe).
 */
function poseSnapshotBody(b: BodyState, prevPoses: PrevPoses): BodyState | null {
  const snap = prevPoses.get(b.instanceId);
  if (!snap) return null;
  return { ...b, position: snap.position, quaternion: snap.quaternion };
}

/**
 * The generic tree-edge warm-start:
 *
 *   1. Decide the joint params. If the frame-N snapshot had the mate
 *      satisfied, EXTRACT the free params from the snapshot (steady
 *      drag → preserve accumulated joint state); else reseed from the
 *      mate options (fresh assembly). Fixed params always come from
 *      the options, which makes the extract→pose round trip snap the
 *      follower onto the exact mate manifold every frame.
 *   2. Add the generic drag delta (grab-point formulation).
 *   3. Clamp limits (with the ±180° unwrap against the snapshot angle).
 *   4. Write the follower pose via `pose()` and lock it.
 */
function seedTreeEdge(
  edge: TreeEdge,
  mates: MateRecord[],
  drag: TreeDragInfo,
  bodyById: Map<string, BodyState>,
  prevPoses: PrevPoses,
  clusters: FastenedClusterCache | undefined,
): void {
  const { parent: driver, child: follower, parentConn: driverConn, childConn: followerConn, mate } = edge;
  // Tripwire: with multi-source BFS every grounded body is a BFS root,
  // so a grounded follower can never appear on a tree edge. If one does
  // (malformed graph from a future regression), refuse to move it — the
  // solver must never relocate a grounded body.
  if (follower.grounded) {
    console.warn(
      `[solver] tree edge ${mate.mateId} has grounded follower `
      + `${follower.instanceId} — skipping warm-start`,
    );
    return;
  }
  const spec = JOINT_SPECS[mate.type];
  // 'parallel' and 'pin-slot' have no warm-start yet; their tree edges
  // are no-ops (the child stays at its input pose, unlocked). They're
  // rejected at parse time until their phases land.
  if (!spec) return;
  const options = mate.options ?? {};
  // Mate options are authored in connector A's frame. When the tree
  // traverses the mate from the B side, the seed works in the B-side
  // param space: measurements (extract/dragDelta) are already B-side,
  // and the option-fixed components / limit bounds map through the
  // inverse relation (see joint-model.ts "Reversed-edge param space").
  const reversed = !edge.parentIsA;

  let snapshotParams: JointParams | null = null;
  let poseOptions: MateOptions = options;
  let params: JointParams | null = null;
  if (hasFreeParams(spec)) {
    const driverSnap = poseSnapshotBody(driver, prevPoses);
    const followerSnap = poseSnapshotBody(follower, prevPoses);
    // Satisfied is a geometric truth of the AUTHORED relation — always
    // evaluated with the mate's A side as the reference.
    const wasSatisfied = driverSnap !== null && followerSnap !== null
      && (reversed
        ? isSatisfied(mate.type, followerSnap, followerConn, driverSnap, driverConn, options)
        : isSatisfied(mate.type, driverSnap, driverConn, followerSnap, followerConn, options));
    if (wasSatisfied && driverSnap && followerSnap) {
      // The freeRotZ axis-parallel manifold has two chirality branches
      // (Z along / Z opposed); revolute preserves the OBSERVED branch
      // so a solve never flips a satisfied body 180° onto the options
      // branch (see JointSpec.preserveChirality for why revolute only).
      if (spec.preserveChirality) {
        poseOptions = {
          ...options,
          flip: observedFlip(driverSnap, driverConn, followerSnap, followerConn),
        };
      }
      const extracted = extract(driverSnap, driverConn, followerSnap, followerConn);
      snapshotParams = reversed
        ? mergeParamsReversed(spec, extracted, poseOptions)
        : mergeParams(spec, extracted, poseOptions);
      params = { ...snapshotParams };
    }
  }
  if (params === null) {
    params = reversed ? defaultParamsReversed(poseOptions) : defaultParams(poseOptions);
  }

  // Kinematic driver: pin the free scalar at the commanded value. Same
  // sign convention as mateReadoutValue — B-side traversal measures the
  // authored value face-to-face and its negation under flip.
  if (drag.drivenJoint?.mateId === mate.mateId && spec.limitParam) {
    const sign = reversed && options.flip ? -1 : 1;
    params[spec.limitParam] = sign * drag.drivenJoint.value;
  }

  const delta = dragDelta(
    spec, driver, driverConn, follower, mates, drag, bodyById, clusters,
  );
  params.rotZ += delta.rotZ;
  params.slideZ += delta.slideZ;
  params.x += delta.x;
  params.y += delta.y;

  // Clamp AFTER the drag delta so a drag past the bound pins at the
  // bound; the rotZ unwrap keeps the clamp stable across the ±180° cut.
  // Reversed edges clamp against the bounds mapped into B-space.
  const effLimits = reversed && options.limits
    ? reversedLimits(options.limits, poseOptions.flip)
    : options.limits;
  clampParamsToLimits(spec, params, effLimits, snapshotParams);

  // Reversed edges re-derive the option-fixed components at the final
  // angle (they're angle-dependent when a lateral offset meets a free
  // rotZ); forward edges pose with the params as-is.
  const poseParams = reversed ? mergeParamsReversed(spec, params, poseOptions) : params;
  const target = pose(driver, driverConn, followerConn, poseOptions, poseParams);
  follower.position = target.position;
  follower.quaternion = target.quaternion;
  follower.lockPosition = true;
  follower.lockOrientation = true;
}

/**
 * The generic tree-edge fixup: read the free params from the post-solve
 * input pair — `edge.parent`/`edge.child` alias `input.bodies`, which
 * the LM pass mutates in place, so this is where an LM'd slide/angle
 * comes from — then re-derive the follower from the SOLVED driver pose
 * (which an earlier fixup in BFS order may itself have rewritten).
 */
function fixupTreeEdge(edge: TreeEdge, outById: Map<string, SolvedBody>): void {
  const { parent, child, parentConn, childConn, mate } = edge;
  const parentOut = outById.get(parent.instanceId);
  const childOut = outById.get(child.instanceId);
  if (!parentOut || !childOut) return;
  // Tripwire: see seedTreeEdge — a grounded follower on a tree edge is
  // unreachable with the multi-source BFS; never overwrite its pose.
  if (child.grounded) {
    console.warn(
      `[solver] tree edge ${mate.mateId} has grounded follower `
      + `${child.instanceId} — skipping fixup`,
    );
    return;
  }
  const spec = JOINT_SPECS[mate.type];
  if (!spec) return;
  const options = mate.options ?? {};
  const reversed = !edge.parentIsA;

  // Preserve the chirality branch the warm-start / LM decided on (see
  // seedTreeEdge) — the fixup must never flip a body 180°.
  const poseOptions: MateOptions = spec.preserveChirality
    ? { ...options, flip: observedFlip(parent, parentConn, child, childConn) }
    : options;
  const extracted = extract(parent, parentConn, child, childConn);
  const params = reversed
    ? mergeParamsReversed(spec, extracted, poseOptions)
    : mergeParams(spec, extracted, poseOptions);

  const driverState: BodyState = {
    ...parent,
    position: parentOut.position,
    quaternion: parentOut.quaternion,
  };
  const target = pose(driverState, parentConn, childConn, poseOptions, params);
  childOut.position = target.position;
  childOut.quaternion = target.quaternion;
}

// ---------------------------------------------------------------------------
// Drag readout
// ---------------------------------------------------------------------------

export type MateReadout = { kind: 'angle' | 'slide'; value: number };

/**
 * The live value of a 1-DOF mate's free parameter, for display while
 * dragging: revolute → hinge angle (degrees), slider → slide distance
 * (mm). Reported in the AUTHORED (A-side) space — the same quantity,
 * same sign, that `.limits(min, max)` clamps — so a readout sitting at
 * a bound reads exactly the limit value even when the solver drives the
 * mate from its B side (B-side measurements equal the authored value
 * face-to-face and its negation under flip). Returns null for mate
 * types without a single scalar DOF.
 */
export function mateReadoutValue(
  mate: MateRecord,
  driver: BodyState,
  driverConn: ConnectorState,
  follower: BodyState,
  followerConn: ConnectorState,
): MateReadout | null {
  if (mate.type !== 'revolute' && mate.type !== 'slider') return null;
  if (!mate.connectorA) return null;
  const driverIsA = mate.connectorA.instanceId === driver.instanceId
    && mate.connectorA.connectorId === driverConn.connectorId;
  const sign = !driverIsA && mate.options?.flip ? -1 : 1;
  const measured = extract(driver, driverConn, follower, followerConn);
  if (mate.type === 'revolute') {
    return { kind: 'angle', value: sign * measured.rotZ };
  }
  return { kind: 'slide', value: sign * measured.slideZ };
}

// ---------------------------------------------------------------------------
// DOF accounting (called by Solver.solve to report the assembly's remaining
// degrees of freedom in the footer).
// ---------------------------------------------------------------------------

// Placeholder joint DOF for the not-yet-implemented types (no JointSpec
// entry). `parallel` means axis alignment (follower Z parallel to
// driver Z, Onshape's Parallel): that removes 2 rotational DOF and
// leaves 3 translations + 1 rotation = 4 — not the 5 the old table
// claimed. Phase 11/12 turn these into real JointSpec entries.
const UNIMPLEMENTED_FREE_DOF: Partial<Record<MateRecord['type'], number>> = {
  parallel: 4,
  'pin-slot': 2,
};

/**
 * Sum the geometric DOF contributed by tree-edge mates. Each non-both-
 * grounded tree edge contributes its `JointSpec.freeDof` — DOFs that
 * `countFreeBodyDof` can't see because the warm-start locks the
 * followers. Closure-edge mates and fastened mates contribute 0.
 */
export function countTreeFreeDof(
  components: Component[],
): number {
  let extra = 0;
  for (const component of components) {
    for (const edge of component.treeEdges) {
      if (edge.parent.grounded && edge.child.grounded) continue;
      extra += JOINT_SPECS[edge.mate.type]?.freeDof
        ?? UNIMPLEMENTED_FREE_DOF[edge.mate.type]
        ?? 0;
    }
  }
  return extra;
}

/**
 * Free-param DOF the bodies themselves contribute: 3 for position + 3 for
 * orientation per ungrounded body whose corresponding lock flag is unset
 * after the warm-start (a free body → 6, a warm-start-locked follower →
 * 0). The footer adds `countTreeFreeDof` on top for the geometric joint
 * DOF that the locked followers otherwise hide.
 */
export function countFreeBodyDof(bodies: BodyState[]): number {
  let dof = 0;
  for (const b of bodies) {
    if (b.grounded) continue;
    if (!b.lockPosition) dof += 3;
    if (!b.lockOrientation) dof += 3;
  }
  return dof;
}
