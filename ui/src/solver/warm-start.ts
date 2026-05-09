// Per-mate warm-start + post-solve fixup, dispatched in BFS spanning-tree
// order over the mate graph.
//
// Background: slvs has no primitive for "Q_B = Q_A · R_fixed", and its
// 2D-in-workplane connector entities project onto the body's xy plane
// (the connector's local Z component is dropped). So `POINTS_COINCIDENT`
// can't faithfully represent a connector that lives on a face above or
// below the body's origin, and `PARALLEL` on body normals only matches
// connector Z-axis parallelism when each connector's local Z aligns with
// its body's Z. Both problems disappear if we keep the mate's follower
// outside the solver's hands:
//
//   1. **Warm-start** (pre-solve, `seed<Mate>Edge`): given a tree edge
//      `parent→child`, compute the child's full target pose
//      (origin + quat) analytically and write it back into the BodyState
//      that buildSystem will consume. Set `lockPosition` and
//      `lockOrientation` on the child so all 7 of its params are placed
//      in `GROUP_GROUND` — slvs does not touch them, and the DOF count
//      stays correct (a grounded driver + fastened follower → 0 DOF).
//
//   2. **Fixup** (post-solve, `fixup<Mate>Edge`): after the solver
//      runs, the parent's pose may have changed (drag, other
//      constraint). Recompute the child's target from the *solved*
//      parent pose and overwrite `out.bodies[child]`. State.group then
//      reflects the correct relation in every frame.
//
// Driver/follower is fixed by graph topology: for a tree edge
// `parent → child`, parent is the driver and child is the follower.
// The graph builder picks the seed (grounded body if any, then dragged,
// then first by input order) and orders edges by BFS depth, so chains
// like `A grounded → revolute → B → fastened → C` propagate correctly
// in a single pass without role-replay logic.
//
// Closed loops are still hard: tree-edge warm-starts cover the spanning
// tree, but closure mates are skipped here. They get enforced by an
// LM relaxation pass (stage 2 of the closed-loop solver plan).

import { Matrix4, Quaternion, Vector3 } from 'three';
import type { Component, TreeEdge } from './graph.js';
import type { BodyState, ConnectorState, MateRecord, SolvedBody } from './types.js';

export type TreeDragInfo = {
  draggedInstanceId?: string;
  /** Raw cursor world position on the drag plane. */
  draggedCursorWorld?: Vector3;
  /** Grab point in body-local frame. */
  draggedGrabLocal?: Vector3;
};

/**
 * Walk every component's tree edges in BFS order, applying the
 * appropriate per-mate warm-start to each. After this returns, every
 * follower body in a tree edge has `lockPosition + lockOrientation`
 * set; `buildSystem` will place those params in GROUP_GROUND.
 *
 * Closure edges are skipped — they're enforced by the LM relaxation
 * pass (stage 2+).
 *
 * `slvsLoopBodies` flags bodies that participate in a slvs-solvable
 * closed loop (see slvs-loop.ts). Tree edges still seed those bodies'
 * poses — slvs gets a good initial guess — but the lockPosition /
 * lockOrientation flags are cleared at the end so slvs sees the params
 * as free and can solve the closure natively.
 */
export function applyTreeWarmStarts(
  bodies: BodyState[],
  components: Component[],
  mates: MateRecord[],
  drag: TreeDragInfo = {},
  slvsLoopBodies: Set<string> = new Set(),
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
  // Loop bodies in slvs-solvable components stay free at the slvs
  // level — clear the lock flags the per-edge seeders set above. The
  // pose remains as initial guess for slvs.
  if (slvsLoopBodies.size > 0) {
    for (const body of bodies) {
      if (slvsLoopBodies.has(body.instanceId)) {
        body.lockPosition = false;
        body.lockOrientation = false;
      }
    }
  }
}

/**
 * Re-derive every tree-edge follower from the SOLVED driver pose.
 * Runs in BFS forward order so chained mates propagate: edge 1's
 * fixup updates the second body, then edge 2's fixup reads that
 * second body as its driver.
 *
 * Tree edges whose child is a slvs-solvable loop body are skipped —
 * slvs already solved the child's pose against the closure constraints,
 * and re-deriving from the parent here would overwrite that solution
 * with a single-edge fastened-style guess that ignores the closure.
 */
export function applyTreeFixups(
  components: Component[],
  out: SolvedBody[],
  slvsLoopBodies: Set<string> = new Set(),
): void {
  const outById = new Map(out.map(b => [b.instanceId, b]));
  for (const component of components) {
    for (const edge of component.treeEdges) {
      if (slvsLoopBodies.has(edge.child.instanceId)) continue;
      fixupTreeEdge(edge, outById);
    }
  }
}

type PrevPoses = Map<string, { position: Vector3; quaternion: Quaternion }>;

/**
 * Returns a `BodyState` whose position and quaternion are the snapshot
 * values from frame N (before any warm-start mutation in this pass).
 * Used by per-edge seed functions that need to evaluate "was the mate
 * satisfied at the start of this solve?" without being misled by
 * upstream warm-start mutations that already happened in this pass.
 *
 * Returns null if no snapshot exists (shouldn't happen in normal
 * flow, but keeps callers safe).
 */
function poseSnapshotBody(b: BodyState, prevPoses: PrevPoses): BodyState | null {
  const snap = prevPoses.get(b.instanceId);
  if (!snap) return null;
  return { ...b, position: snap.position, quaternion: snap.quaternion };
}

function seedTreeEdge(
  edge: TreeEdge,
  mates: MateRecord[],
  drag: TreeDragInfo,
  bodyById: Map<string, BodyState>,
  prevPoses: PrevPoses,
  clusters: FastenedClusterCache | undefined,
): void {
  const { parent, child, parentConn, childConn, mate } = edge;
  switch (mate.type) {
    case 'fastened':
      seedFastenedEdge(parent, child, parentConn, childConn, mate);
      break;
    case 'revolute':
      seedRevoluteEdge(parent, child, parentConn, childConn, mate, mates, drag, bodyById, prevPoses, clusters);
      break;
    case 'slider':
      seedSliderEdge(parent, child, parentConn, childConn, mate, mates, drag, bodyById, prevPoses, clusters);
      break;
    case 'cylindrical':
      seedCylindricalEdge(parent, child, parentConn, childConn, mate, mates, drag, bodyById, prevPoses, clusters);
      break;
    case 'planar':
      seedPlanarEdge(parent, child, parentConn, childConn, mate, mates, drag, bodyById, prevPoses, clusters);
      break;
    // 'parallel' and 'pin-slot' have no warm-start yet; their tree edges
    // are no-ops (the child stays at its input pose). They'll be handled
    // by phase 11 / 12 alongside the LM relaxation.
    default:
      break;
  }
}

function fixupTreeEdge(edge: TreeEdge, outById: Map<string, SolvedBody>): void {
  const { parent, child, parentConn, childConn, mate } = edge;
  const parentOut = outById.get(parent.instanceId);
  const childOut = outById.get(child.instanceId);
  if (!parentOut || !childOut) return;
  switch (mate.type) {
    case 'fastened':
      fixupFastenedEdge(parent, parentConn, childConn, mate, parentOut, childOut);
      break;
    case 'revolute':
      fixupRevoluteEdge(parent, parentConn, childConn, mate, parentOut, childOut);
      break;
    case 'slider':
      fixupSliderEdge(parent, child, parentConn, childConn, mate, parentOut, childOut);
      break;
    case 'cylindrical':
      fixupCylindricalEdge(parent, child, parentConn, childConn, mate, parentOut, childOut);
      break;
    case 'planar':
      fixupPlanarEdge(parent, child, parentConn, childConn, mate, parentOut, childOut);
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Fastened
// ---------------------------------------------------------------------------

function seedFastenedEdge(
  driver: BodyState,
  follower: BodyState,
  driverConn: ConnectorState,
  followerConn: ConnectorState,
  mate: MateRecord,
): void {
  // Both bodies grounded → mate is either pre-satisfied or permanently
  // violated; the warm-start can't help. Skip without locking.
  if (driver.grounded && follower.grounded) return;
  const target = computeFastenedTargetPose(
    driver, driverConn, followerConn, mate.options ?? {},
  );
  follower.position = target.position;
  follower.quaternion = target.quaternion;
  follower.lockPosition = true;
  follower.lockOrientation = true;
}

function fixupFastenedEdge(
  inputDriver: BodyState,
  driverConn: ConnectorState,
  followerConn: ConnectorState,
  mate: MateRecord,
  driverOut: SolvedBody,
  followerOut: SolvedBody,
): void {
  const driverState: BodyState = {
    ...inputDriver,
    position: driverOut.position,
    quaternion: driverOut.quaternion,
  };
  const target = computeFastenedTargetPose(
    driverState, driverConn, followerConn, mate.options ?? {},
  );
  followerOut.position = target.position;
  followerOut.quaternion = target.quaternion;
}

// ---------------------------------------------------------------------------
// Revolute
// ---------------------------------------------------------------------------

const REVOLUTE_EPS = 1e-4;

function seedRevoluteEdge(
  driver: BodyState,
  follower: BodyState,
  driverConn: ConnectorState,
  followerConn: ConnectorState,
  mate: MateRecord,
  allMates: MateRecord[],
  drag: TreeDragInfo,
  bodyById: Map<string, BodyState>,
  prevPoses: PrevPoses,
  clusters: FastenedClusterCache | undefined,
): void {
  if (driver.grounded && follower.grounded) return;
  const options = mate.options ?? {};

  // Decide reseed against the SNAPSHOT (frame N's input pose), not the
  // mid-warm-start mutated state. When the driver gets dragged, the
  // current driver pose has already moved, so a current-state check
  // sees mate as violated by the cursor delta — re-seeding the
  // follower would wipe its accumulated free-DOF rotation. Checking
  // the snapshot tells us whether frame N's solved state had the mate
  // satisfied (steady-state drag → preserve) or not (fresh assembly
  // → reseed).
  const driverSnap = poseSnapshotBody(driver, prevPoses);
  const followerSnap = poseSnapshotBody(follower, prevPoses);
  const wasSatisfied = driverSnap !== null && followerSnap !== null
    && isRevoluteSatisfied(driverSnap, followerSnap, driverConn, followerConn, options);

  if (!wasSatisfied) {
    const seed = computeFastenedTargetPose(driver, driverConn, followerConn, options);
    follower.position = seed.position;
    follower.quaternion = seed.quaternion;
  }

  // Drag-of-cluster: rotate the follower about the pivot Z by the angle
  // that brings the *grab point* to the cursor. The grab point may live
  // on the follower itself, or on any body fastened-connected to it
  // (the rigid cluster pivots as one).
  applyRevoluteDragRotation(driver, follower, driverConn, allMates, drag, bodyById, clusters);

  // Re-derive position from the (possibly rotated) orientation so the
  // connector frames truly coincide in world space, regardless of which
  // path set the orientation above.
  follower.position = followerPositionFromOrientation(
    driver, driverConn, followerConn, follower.quaternion, options,
  );

  follower.lockPosition = true;
  follower.lockOrientation = true;
}

function fixupRevoluteEdge(
  inputDriver: BodyState,
  driverConn: ConnectorState,
  followerConn: ConnectorState,
  mate: MateRecord,
  driverOut: SolvedBody,
  followerOut: SolvedBody,
): void {
  const driverState: BodyState = {
    ...inputDriver,
    position: driverOut.position,
    quaternion: driverOut.quaternion,
  };
  // Keep the follower's solved orientation (which equals warm-start's
  // because we locked it) and re-derive position from the driver's
  // possibly-updated pose.
  followerOut.position = followerPositionFromOrientation(
    driverState, driverConn, followerConn, followerOut.quaternion,
    mate.options ?? {},
  );
}

function applyRevoluteDragRotation(
  driver: BodyState,
  follower: BodyState,
  driverConn: ConnectorState,
  allMates: MateRecord[],
  drag: TreeDragInfo,
  bodyById: Map<string, BodyState>,
  clusters: FastenedClusterCache | undefined,
): void {
  const { draggedInstanceId, draggedCursorWorld, draggedGrabLocal } = drag;
  if (!draggedCursorWorld || !draggedGrabLocal || !draggedInstanceId) return;
  if (follower.grounded) return;
  const cluster = clusters?.get(follower.instanceId)
    ?? findFastenedCluster(follower.instanceId, allMates);
  if (!cluster.has(draggedInstanceId)) return;
  const draggedBody = bodyById.get(draggedInstanceId);
  if (!draggedBody) return;
  const grabWorld = draggedGrabLocal.clone()
    .applyQuaternion(draggedBody.quaternion)
    .add(draggedBody.position);
  rotateFollowerTowardWorld(driver, follower, driverConn, draggedCursorWorld, grabWorld);
}

function isRevoluteSatisfied(
  driver: BodyState,
  follower: BodyState,
  driverConn: ConnectorState,
  followerConn: ConnectorState,
  options: { rotate?: number; flip?: boolean; offset?: [number, number, number] },
): boolean {
  const dOriginWorld = driverConn.localOrigin.clone()
    .applyQuaternion(driver.quaternion).add(driver.position);
  const dZWorld = driverConn.localNormal.clone()
    .applyQuaternion(driver.quaternion).normalize();
  const fOriginWorld = followerConn.localOrigin.clone()
    .applyQuaternion(follower.quaternion).add(follower.position);
  const fZWorld = followerConn.localNormal.clone()
    .applyQuaternion(follower.quaternion).normalize();

  let target = dOriginWorld.clone();
  if (options.offset) {
    const dXWorld = driverConn.localXDirection.clone()
      .applyQuaternion(driver.quaternion).normalize();
    const dYWorld = new Vector3().crossVectors(dZWorld, dXWorld).normalize();
    const [ox, oy, oz] = options.offset;
    target.addScaledVector(dXWorld, ox)
      .addScaledVector(dYWorld, oy)
      .addScaledVector(dZWorld, oz);
  }

  if (fOriginWorld.distanceTo(target) > REVOLUTE_EPS) return false;
  return Math.abs(Math.abs(fZWorld.dot(dZWorld)) - 1) < REVOLUTE_EPS;
}

function rotateFollowerTowardWorld(
  driver: BodyState,
  follower: BodyState,
  driverConn: ConnectorState,
  cursorWorld: Vector3,
  grabWorld: Vector3,
): void {
  const pivot = driverConn.localOrigin.clone()
    .applyQuaternion(driver.quaternion).add(driver.position);
  const axis = driverConn.localNormal.clone()
    .applyQuaternion(driver.quaternion).normalize();

  const fromVec = grabWorld.clone().sub(pivot);
  const fromInPlane = fromVec.clone()
    .sub(axis.clone().multiplyScalar(fromVec.dot(axis)));
  const toVec = cursorWorld.clone().sub(pivot);
  const toInPlane = toVec.clone()
    .sub(axis.clone().multiplyScalar(toVec.dot(axis)));

  if (fromInPlane.length() < 1e-9 || toInPlane.length() < 1e-9) return;
  fromInPlane.normalize();
  toInPlane.normalize();

  const cos = Math.min(1, Math.max(-1, fromInPlane.dot(toInPlane)));
  const cross = new Vector3().crossVectors(fromInPlane, toInPlane);
  const sin = cross.dot(axis);
  const angle = Math.atan2(sin, cos);
  if (Math.abs(angle) < 1e-9) return;

  const dq = new Quaternion().setFromAxisAngle(axis, angle);
  follower.quaternion = dq.multiply(follower.quaternion);
}

function followerPositionFromOrientation(
  driver: BodyState,
  driverConn: ConnectorState,
  followerConn: ConnectorState,
  followerQuat: Quaternion,
  options: { rotate?: number; flip?: boolean; offset?: [number, number, number] },
): Vector3 {
  const dOriginWorld = driverConn.localOrigin.clone()
    .applyQuaternion(driver.quaternion).add(driver.position);
  let target = dOriginWorld.clone();
  if (options.offset) {
    const dZWorld = driverConn.localNormal.clone()
      .applyQuaternion(driver.quaternion).normalize();
    const dXWorld = driverConn.localXDirection.clone()
      .applyQuaternion(driver.quaternion).normalize();
    const dYWorld = new Vector3().crossVectors(dZWorld, dXWorld).normalize();
    const [ox, oy, oz] = options.offset;
    target.addScaledVector(dXWorld, ox)
      .addScaledVector(dYWorld, oy)
      .addScaledVector(dZWorld, oz);
  }
  return target.clone().sub(
    followerConn.localOrigin.clone().applyQuaternion(followerQuat),
  );
}

// ---------------------------------------------------------------------------
// Slider
// ---------------------------------------------------------------------------

const SLIDER_EPS = 1e-4;

function seedSliderEdge(
  driver: BodyState,
  follower: BodyState,
  driverConn: ConnectorState,
  followerConn: ConnectorState,
  mate: MateRecord,
  allMates: MateRecord[],
  drag: TreeDragInfo,
  bodyById: Map<string, BodyState>,
  prevPoses: PrevPoses,
  clusters: FastenedClusterCache | undefined,
): void {
  if (driver.grounded && follower.grounded) return;
  const options = mate.options ?? {};
  const seedOffsetZ = options.offset?.[2] ?? 0;

  // Read slide value from frame N's snapshot, not the mid-warm-start
  // state. Otherwise, dragging an upstream body changes the apparent
  // slide value because the driver has moved but the follower hasn't
  // — the follower would then drift from its previous slide each
  // frame.
  const driverSnap = poseSnapshotBody(driver, prevPoses);
  const followerSnap = poseSnapshotBody(follower, prevPoses);
  let effectiveZ: number;
  if (driverSnap && followerSnap
      && isSliderOnAxis(driverSnap, followerSnap, driverConn, followerConn)) {
    effectiveZ = currentSliderZOffset(driverSnap, driverConn, followerSnap, followerConn);
  } else {
    effectiveZ = seedOffsetZ;
  }

  effectiveZ += sliderDragDelta(driver, follower, driverConn, allMates, drag, bodyById, clusters);

  const target = computeFastenedTargetPose(driver, driverConn, followerConn, {
    ...options,
    offset: [0, 0, effectiveZ],
  });
  follower.position = target.position;
  follower.quaternion = target.quaternion;
  follower.lockPosition = true;
  follower.lockOrientation = true;
}

function fixupSliderEdge(
  inputDriver: BodyState,
  inputFollower: BodyState,
  driverConn: ConnectorState,
  followerConn: ConnectorState,
  mate: MateRecord,
  driverOut: SolvedBody,
  followerOut: SolvedBody,
): void {
  // Read the slide value from the warm-started follower (input) relative
  // to the input driver. The warm-started follower is consistent with
  // the input driver, so projecting back gives the value the warm-start
  // chose (preserved or freshly seeded).
  const effectiveZ = currentSliderZOffset(
    inputDriver, driverConn, inputFollower, followerConn,
  );
  const driverState: BodyState = {
    ...inputDriver,
    position: driverOut.position,
    quaternion: driverOut.quaternion,
  };
  const target = computeFastenedTargetPose(
    driverState, driverConn, followerConn,
    { ...(mate.options ?? {}), offset: [0, 0, effectiveZ] },
  );
  followerOut.position = target.position;
  followerOut.quaternion = target.quaternion;
}

function sliderDragDelta(
  driver: BodyState,
  follower: BodyState,
  driverConn: ConnectorState,
  allMates: MateRecord[],
  drag: TreeDragInfo,
  bodyById: Map<string, BodyState>,
  clusters: FastenedClusterCache | undefined,
): number {
  const { draggedInstanceId, draggedCursorWorld, draggedGrabLocal } = drag;
  if (!draggedCursorWorld || !draggedGrabLocal || !draggedInstanceId) return 0;
  if (follower.grounded) return 0;
  const cluster = clusters?.get(follower.instanceId)
    ?? findFastenedCluster(follower.instanceId, allMates);
  if (!cluster.has(draggedInstanceId)) return 0;
  const draggedBody = bodyById.get(draggedInstanceId);
  if (!draggedBody) return 0;
  const grabWorld = draggedGrabLocal.clone()
    .applyQuaternion(draggedBody.quaternion)
    .add(draggedBody.position);
  const axis = driverConn.localNormal.clone()
    .applyQuaternion(driver.quaternion).normalize();
  return draggedCursorWorld.clone().sub(grabWorld).dot(axis);
}

function isSliderOnAxis(
  driver: BodyState,
  follower: BodyState,
  driverConn: ConnectorState,
  followerConn: ConnectorState,
): boolean {
  const dOrigin = driverConn.localOrigin.clone()
    .applyQuaternion(driver.quaternion).add(driver.position);
  const dZ = driverConn.localNormal.clone()
    .applyQuaternion(driver.quaternion).normalize();
  const fOrigin = followerConn.localOrigin.clone()
    .applyQuaternion(follower.quaternion).add(follower.position);
  const diff = fOrigin.clone().sub(dOrigin);
  const along = diff.dot(dZ);
  const perp = diff.clone().sub(dZ.clone().multiplyScalar(along));
  return perp.length() < SLIDER_EPS;
}

function currentSliderZOffset(
  driver: BodyState,
  driverConn: ConnectorState,
  follower: BodyState,
  followerConn: ConnectorState,
): number {
  const dOrigin = driverConn.localOrigin.clone()
    .applyQuaternion(driver.quaternion).add(driver.position);
  const dZ = driverConn.localNormal.clone()
    .applyQuaternion(driver.quaternion).normalize();
  const fOrigin = followerConn.localOrigin.clone()
    .applyQuaternion(follower.quaternion).add(follower.position);
  return fOrigin.clone().sub(dOrigin).dot(dZ);
}

// ---------------------------------------------------------------------------
// Cylindrical
// ---------------------------------------------------------------------------

const CYLINDRICAL_EPS = 1e-4;

function seedCylindricalEdge(
  driver: BodyState,
  follower: BodyState,
  driverConn: ConnectorState,
  followerConn: ConnectorState,
  mate: MateRecord,
  allMates: MateRecord[],
  drag: TreeDragInfo,
  bodyById: Map<string, BodyState>,
  prevPoses: PrevPoses,
  clusters: FastenedClusterCache | undefined,
): void {
  if (driver.grounded && follower.grounded) return;
  const options = mate.options ?? {};
  const seedSlide = options.offset?.[2] ?? 0;
  const seedAngle = options.rotate ?? 0;

  // Read slide/angle from snapshot (frame N) so dragging an upstream
  // body doesn't drift the slide/angle away from the user's previous
  // values just because the driver moved this frame.
  const driverSnap = poseSnapshotBody(driver, prevPoses);
  const followerSnap = poseSnapshotBody(follower, prevPoses);
  let slide: number;
  let angle: number;
  if (driverSnap && followerSnap
      && isCylindricalSatisfied(driverSnap, followerSnap, driverConn, followerConn)) {
    const state = currentCylindricalState(driverSnap, followerSnap, driverConn, followerConn);
    slide = state.slide;
    angle = state.angle;
  } else {
    slide = seedSlide;
    angle = seedAngle;
  }

  const drag2 = cylindricalDragDeltas(
    driver, follower, driverConn, allMates, drag, slide, bodyById, clusters,
  );
  slide += drag2.slideDelta;
  angle += drag2.angleDelta;

  const target = computeFastenedTargetPose(driver, driverConn, followerConn, {
    flip: options.flip,
    rotate: angle,
    offset: [0, 0, slide],
  });
  follower.position = target.position;
  follower.quaternion = target.quaternion;
  follower.lockPosition = true;
  follower.lockOrientation = true;
}

function fixupCylindricalEdge(
  inputDriver: BodyState,
  inputFollower: BodyState,
  driverConn: ConnectorState,
  followerConn: ConnectorState,
  mate: MateRecord,
  driverOut: SolvedBody,
  followerOut: SolvedBody,
): void {
  const state = currentCylindricalState(
    inputDriver, inputFollower, driverConn, followerConn,
  );
  const driverState: BodyState = {
    ...inputDriver,
    position: driverOut.position,
    quaternion: driverOut.quaternion,
  };
  const target = computeFastenedTargetPose(
    driverState, driverConn, followerConn,
    {
      flip: mate.options?.flip,
      rotate: state.angle,
      offset: [0, 0, state.slide],
    },
  );
  followerOut.position = target.position;
  followerOut.quaternion = target.quaternion;
}

function cylindricalDragDeltas(
  driver: BodyState,
  follower: BodyState,
  driverConn: ConnectorState,
  allMates: MateRecord[],
  drag: TreeDragInfo,
  currentSlide: number,
  bodyById: Map<string, BodyState>,
  clusters: FastenedClusterCache | undefined,
): { slideDelta: number; angleDelta: number } {
  const { draggedInstanceId, draggedCursorWorld, draggedGrabLocal } = drag;
  const noDelta = { slideDelta: 0, angleDelta: 0 };
  if (!draggedCursorWorld || !draggedGrabLocal || !draggedInstanceId) return noDelta;
  if (follower.grounded) return noDelta;
  const cluster = clusters?.get(follower.instanceId)
    ?? findFastenedCluster(follower.instanceId, allMates);
  if (!cluster.has(draggedInstanceId)) return noDelta;
  const draggedBody = bodyById.get(draggedInstanceId);
  if (!draggedBody) return noDelta;

  const grabWorld = draggedGrabLocal.clone()
    .applyQuaternion(draggedBody.quaternion)
    .add(draggedBody.position);
  const dOrigin = driverConn.localOrigin.clone()
    .applyQuaternion(driver.quaternion).add(driver.position);
  const dZ = driverConn.localNormal.clone()
    .applyQuaternion(driver.quaternion).normalize();

  const slideDelta = draggedCursorWorld.clone().sub(grabWorld).dot(dZ);

  // After the slide, the grab moves with the body by `slideDelta * dZ`.
  // Compute the in-plane rotation about the slid pivot that takes
  // grabAfterSlide → cursor.
  const grabAfterSlide = grabWorld.clone().addScaledVector(dZ, slideDelta);
  const pivotAfterSlide = dOrigin.clone()
    .addScaledVector(dZ, currentSlide + slideDelta);
  const fromVec = grabAfterSlide.clone().sub(pivotAfterSlide);
  const toVec = draggedCursorWorld.clone().sub(pivotAfterSlide);
  const fromInPlane = fromVec.clone()
    .sub(dZ.clone().multiplyScalar(fromVec.dot(dZ)));
  const toInPlane = toVec.clone()
    .sub(dZ.clone().multiplyScalar(toVec.dot(dZ)));
  if (fromInPlane.length() < 1e-9 || toInPlane.length() < 1e-9) {
    return { slideDelta, angleDelta: 0 };
  }
  fromInPlane.normalize();
  toInPlane.normalize();
  const cos = Math.min(1, Math.max(-1, fromInPlane.dot(toInPlane)));
  const sin = new Vector3().crossVectors(fromInPlane, toInPlane).dot(dZ);
  const angleDelta = (Math.atan2(sin, cos) * 180) / Math.PI;
  return { slideDelta, angleDelta };
}

function isCylindricalSatisfied(
  driver: BodyState,
  follower: BodyState,
  driverConn: ConnectorState,
  followerConn: ConnectorState,
): boolean {
  const dOrigin = driverConn.localOrigin.clone()
    .applyQuaternion(driver.quaternion).add(driver.position);
  const dZ = driverConn.localNormal.clone()
    .applyQuaternion(driver.quaternion).normalize();
  const fOrigin = followerConn.localOrigin.clone()
    .applyQuaternion(follower.quaternion).add(follower.position);
  const fZ = followerConn.localNormal.clone()
    .applyQuaternion(follower.quaternion).normalize();
  const diff = fOrigin.clone().sub(dOrigin);
  const along = diff.dot(dZ);
  const perp = diff.clone().sub(dZ.clone().multiplyScalar(along));
  if (perp.length() > CYLINDRICAL_EPS) return false;
  return Math.abs(Math.abs(fZ.dot(dZ)) - 1) < CYLINDRICAL_EPS;
}

function currentCylindricalState(
  driver: BodyState,
  follower: BodyState,
  driverConn: ConnectorState,
  followerConn: ConnectorState,
): { slide: number; angle: number } {
  const dOrigin = driverConn.localOrigin.clone()
    .applyQuaternion(driver.quaternion).add(driver.position);
  const dZ = driverConn.localNormal.clone()
    .applyQuaternion(driver.quaternion).normalize();
  const dX = driverConn.localXDirection.clone()
    .applyQuaternion(driver.quaternion).normalize();
  const fOrigin = followerConn.localOrigin.clone()
    .applyQuaternion(follower.quaternion).add(follower.position);
  const fX = followerConn.localXDirection.clone()
    .applyQuaternion(follower.quaternion).normalize();

  const slide = fOrigin.clone().sub(dOrigin).dot(dZ);

  const fXInPlane = fX.clone().sub(dZ.clone().multiplyScalar(fX.dot(dZ)));
  if (fXInPlane.length() < 1e-9) {
    return { slide, angle: 0 };
  }
  fXInPlane.normalize();
  const cos = Math.min(1, Math.max(-1, fXInPlane.dot(dX)));
  const sin = new Vector3().crossVectors(dX, fXInPlane).dot(dZ);
  const angle = (Math.atan2(sin, cos) * 180) / Math.PI;
  return { slide, angle };
}

// ---------------------------------------------------------------------------
// Planar
// ---------------------------------------------------------------------------

const PLANAR_EPS = 1e-4;

function seedPlanarEdge(
  driver: BodyState,
  follower: BodyState,
  driverConn: ConnectorState,
  followerConn: ConnectorState,
  mate: MateRecord,
  allMates: MateRecord[],
  drag: TreeDragInfo,
  bodyById: Map<string, BodyState>,
  prevPoses: PrevPoses,
  clusters: FastenedClusterCache | undefined,
): void {
  if (driver.grounded && follower.grounded) return;
  const options = mate.options ?? {};
  const dz = options.offset?.[2] ?? 0;
  const seedAngle = options.rotate ?? 0;

  // Read xLocal/yLocal/angle from snapshot (frame N) so dragging an
  // upstream body doesn't drift the in-plane translation/rotation
  // away from the user's previous values.
  const driverSnap = poseSnapshotBody(driver, prevPoses);
  const followerSnap = poseSnapshotBody(follower, prevPoses);
  let xLocal: number;
  let yLocal: number;
  let angle: number;
  if (driverSnap && followerSnap
      && isPlanarSatisfied(driverSnap, followerSnap, driverConn, followerConn, dz)) {
    const state = currentPlanarState(driverSnap, followerSnap, driverConn, followerConn, dz);
    xLocal = state.x;
    yLocal = state.y;
    angle = state.angle;
  } else {
    xLocal = 0;
    yLocal = 0;
    angle = seedAngle;
  }

  const planarDelta = planarDragDelta(driver, follower, driverConn, allMates, drag, bodyById, clusters);
  xLocal += planarDelta.x;
  yLocal += planarDelta.y;

  const target = computeFastenedTargetPose(driver, driverConn, followerConn, {
    flip: options.flip,
    rotate: angle,
    offset: [xLocal, yLocal, dz],
  });
  follower.position = target.position;
  follower.quaternion = target.quaternion;
  follower.lockPosition = true;
  follower.lockOrientation = true;
}

function fixupPlanarEdge(
  inputDriver: BodyState,
  inputFollower: BodyState,
  driverConn: ConnectorState,
  followerConn: ConnectorState,
  mate: MateRecord,
  driverOut: SolvedBody,
  followerOut: SolvedBody,
): void {
  const dz = mate.options?.offset?.[2] ?? 0;
  const state = currentPlanarState(
    inputDriver, inputFollower, driverConn, followerConn, dz,
  );
  const driverState: BodyState = {
    ...inputDriver,
    position: driverOut.position,
    quaternion: driverOut.quaternion,
  };
  const target = computeFastenedTargetPose(
    driverState, driverConn, followerConn,
    {
      flip: mate.options?.flip,
      rotate: state.angle,
      offset: [state.x, state.y, dz],
    },
  );
  followerOut.position = target.position;
  followerOut.quaternion = target.quaternion;
}

function planarDragDelta(
  driver: BodyState,
  follower: BodyState,
  driverConn: ConnectorState,
  allMates: MateRecord[],
  drag: TreeDragInfo,
  bodyById: Map<string, BodyState>,
  clusters: FastenedClusterCache | undefined,
): { x: number; y: number } {
  const { draggedInstanceId, draggedCursorWorld, draggedGrabLocal } = drag;
  const noDelta = { x: 0, y: 0 };
  if (!draggedCursorWorld || !draggedGrabLocal || !draggedInstanceId) return noDelta;
  if (follower.grounded) return noDelta;
  const cluster = clusters?.get(follower.instanceId)
    ?? findFastenedCluster(follower.instanceId, allMates);
  if (!cluster.has(draggedInstanceId)) return noDelta;
  const draggedBody = bodyById.get(draggedInstanceId);
  if (!draggedBody) return noDelta;

  const grabWorld = draggedGrabLocal.clone()
    .applyQuaternion(draggedBody.quaternion)
    .add(draggedBody.position);
  const dX = driverConn.localXDirection.clone()
    .applyQuaternion(driver.quaternion).normalize();
  const dZ = driverConn.localNormal.clone()
    .applyQuaternion(driver.quaternion).normalize();
  const dY = new Vector3().crossVectors(dZ, dX).normalize();
  const delta = draggedCursorWorld.clone().sub(grabWorld);
  return { x: delta.dot(dX), y: delta.dot(dY) };
}

function isPlanarSatisfied(
  driver: BodyState,
  follower: BodyState,
  driverConn: ConnectorState,
  followerConn: ConnectorState,
  dz: number,
): boolean {
  const dOrigin = driverConn.localOrigin.clone()
    .applyQuaternion(driver.quaternion).add(driver.position);
  const dZ = driverConn.localNormal.clone()
    .applyQuaternion(driver.quaternion).normalize();
  const planeOrigin = dOrigin.clone().addScaledVector(dZ, dz);
  const fOrigin = followerConn.localOrigin.clone()
    .applyQuaternion(follower.quaternion).add(follower.position);
  const fZ = followerConn.localNormal.clone()
    .applyQuaternion(follower.quaternion).normalize();
  const along = Math.abs(fOrigin.clone().sub(planeOrigin).dot(dZ));
  if (along > PLANAR_EPS) return false;
  return Math.abs(Math.abs(fZ.dot(dZ)) - 1) < PLANAR_EPS;
}

function currentPlanarState(
  driver: BodyState,
  follower: BodyState,
  driverConn: ConnectorState,
  followerConn: ConnectorState,
  dz: number,
): { x: number; y: number; angle: number } {
  const dOrigin = driverConn.localOrigin.clone()
    .applyQuaternion(driver.quaternion).add(driver.position);
  const dX = driverConn.localXDirection.clone()
    .applyQuaternion(driver.quaternion).normalize();
  const dZ = driverConn.localNormal.clone()
    .applyQuaternion(driver.quaternion).normalize();
  const dY = new Vector3().crossVectors(dZ, dX).normalize();
  const planeOrigin = dOrigin.clone().addScaledVector(dZ, dz);
  const fOrigin = followerConn.localOrigin.clone()
    .applyQuaternion(follower.quaternion).add(follower.position);
  const fX = followerConn.localXDirection.clone()
    .applyQuaternion(follower.quaternion).normalize();

  const diff = fOrigin.clone().sub(planeOrigin);
  const x = diff.dot(dX);
  const y = diff.dot(dY);

  const fXInPlane = fX.clone().sub(dZ.clone().multiplyScalar(fX.dot(dZ)));
  if (fXInPlane.length() < 1e-9) {
    return { x, y, angle: 0 };
  }
  fXInPlane.normalize();
  const cos = Math.min(1, Math.max(-1, fXInPlane.dot(dX)));
  const sin = new Vector3().crossVectors(dX, fXInPlane).dot(dZ);
  const angle = (Math.atan2(sin, cos) * 180) / Math.PI;
  return { x, y, angle };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Set of instance ids that are fastened-connected to `rootId` (transitively).
 * A fastened cluster moves as a single rigid body, so a drag of any cluster
 * member is equivalent to dragging the cluster as a whole — relevant for
 * the non-fastened tree-edge warm-starts where the dragged body need not
 * be the immediate follower.
 */
function findFastenedCluster(rootId: string, mates: MateRecord[]): Set<string> {
  const cluster = new Set<string>([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const m of mates) {
      if (m.type !== 'fastened') continue;
      const a = m.connectorA.instanceId;
      const b = m.connectorB.instanceId;
      if (cluster.has(a) && !cluster.has(b)) {
        cluster.add(b);
        changed = true;
      } else if (cluster.has(b) && !cluster.has(a)) {
        cluster.add(a);
        changed = true;
      }
    }
  }
  return cluster;
}

/**
 * id → set of all instance ids fastened-connected to it (transitively).
 * Bodies in the same fastened cluster share the same Set instance, so the
 * map is O(N_bodies) entries pointing at O(N_components) underlying sets.
 *
 * Built ONCE per `Solver.solve()` and threaded through the warm-start so
 * the per-edge drag helpers do an O(1) lookup instead of recomputing
 * `findFastenedCluster` (O(N_mates × N_cluster)) per non-fastened tree
 * edge per frame. Without this, dragging a body in a heavy fastened
 * cluster pegs the CPU because every tree-edge drag-helper rescans the
 * full mates list to discover whether the dragged body is fastened-
 * equivalent to that edge's follower.
 */
export type FastenedClusterCache = Map<string, Set<string>>;

export function buildFastenedClusterCache(
  bodies: BodyState[],
  mates: MateRecord[],
): FastenedClusterCache {
  const adj = new Map<string, string[]>();
  for (const b of bodies) adj.set(b.instanceId, []);
  for (const m of mates) {
    if (m.type !== 'fastened') continue;
    const a = m.connectorA.instanceId;
    const b = m.connectorB.instanceId;
    adj.get(a)?.push(b);
    adj.get(b)?.push(a);
  }
  const compOf = new Map<string, Set<string>>();
  for (const b of bodies) {
    if (compOf.has(b.instanceId)) continue;
    const set = new Set<string>();
    const stack = [b.instanceId];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (set.has(cur)) continue;
      set.add(cur);
      const neighbors = adj.get(cur);
      if (!neighbors) continue;
      for (const nb of neighbors) {
        if (!set.has(nb)) stack.push(nb);
      }
    }
    for (const id of set) compOf.set(id, set);
  }
  return compOf;
}

// ---------------------------------------------------------------------------
// Fastened target-pose computation (the analytical kernel reused by all
// non-fastened mate types as their face-to-face/anti-parallel base pose).
// ---------------------------------------------------------------------------

/**
 * Compute the follower body's world pose (origin + quat) so that the
 * follower's connector lines up face-to-face with the driver's connector,
 * with optional rotate / flip / offset applied.
 */
export function computeFastenedTargetPose(
  driver: BodyState,
  driverConn: ConnectorState,
  followerConn: ConnectorState,
  options: { rotate?: number; flip?: boolean; offset?: [number, number, number] },
): { position: Vector3; quaternion: Quaternion } {
  const dOriginWorld = driverConn.localOrigin.clone()
    .applyQuaternion(driver.quaternion)
    .add(driver.position);
  const dXWorld = driverConn.localXDirection.clone()
    .applyQuaternion(driver.quaternion).normalize();
  const dZWorld = driverConn.localNormal.clone()
    .applyQuaternion(driver.quaternion).normalize();
  const dYWorld = new Vector3().crossVectors(dZWorld, dXWorld).normalize();

  let targetOriginWorld = dOriginWorld.clone();
  if (options.offset) {
    const [ox, oy, oz] = options.offset;
    targetOriginWorld
      .addScaledVector(dXWorld, ox)
      .addScaledVector(dYWorld, oy)
      .addScaledVector(dZWorld, oz);
  }

  const faceToFace = !options.flip;
  const targetZ = faceToFace ? dZWorld.clone().negate() : dZWorld.clone();

  let targetX = dXWorld.clone();
  if (options.rotate) {
    targetX.applyAxisAngle(dZWorld, options.rotate * Math.PI / 180);
  }
  targetX.sub(targetZ.clone().multiplyScalar(targetX.dot(targetZ))).normalize();
  const targetY = new Vector3().crossVectors(targetZ, targetX).normalize();

  const targetMatrix = new Matrix4().makeBasis(targetX, targetY, targetZ);

  const fLocalY = new Vector3().crossVectors(followerConn.localNormal, followerConn.localXDirection).normalize();
  const fLocalMatrix = new Matrix4().makeBasis(
    followerConn.localXDirection.clone().normalize(),
    fLocalY,
    followerConn.localNormal.clone().normalize(),
  );

  const fLocalInverse = fLocalMatrix.clone().transpose();
  const bodyMatrix = new Matrix4().multiplyMatrices(targetMatrix, fLocalInverse);
  const bodyQuat = new Quaternion().setFromRotationMatrix(bodyMatrix);

  const localOriginRotated = followerConn.localOrigin.clone().applyQuaternion(bodyQuat);
  const bodyPos = targetOriginWorld.clone().sub(localOriginRotated);

  return { position: bodyPos, quaternion: bodyQuat };
}

// ---------------------------------------------------------------------------
// DOF accounting (called by Solver.solve to add geometric DOF that slvs
// can't see because tree-mate followers have lockPosition+lockOrientation).
// ---------------------------------------------------------------------------

const PER_TYPE_FREE_DOF: Record<MateRecord['type'], number> = {
  fastened: 0,
  revolute: 1,
  slider: 1,
  cylindrical: 2,
  planar: 3,
  parallel: 5,
  'pin-slot': 2,
};

/**
 * Sum the geometric DOF contributed by tree-edge mates. Each non-both-
 * grounded tree edge of type `revolute` (1), `slider` (1), `cylindrical`
 * (2), `planar` (3), `parallel` (5), `pin-slot` (2) contributes that
 * many DOFs that slvs can't see — the followers are locked by the
 * warm-start. Closure-edge mates and fastened mates contribute 0.
 *
 * Tree edges whose child is in `slvsLoopBodies` are skipped: those
 * followers are NOT locked, so slvs already accounts for the joint's
 * free DOF in its own per-group DOF reading.
 */
export function countTreeFreeDof(
  components: Component[],
  slvsLoopBodies: Set<string> = new Set(),
): number {
  let extra = 0;
  for (const component of components) {
    for (const edge of component.treeEdges) {
      if (edge.parent.grounded && edge.child.grounded) continue;
      if (slvsLoopBodies.has(edge.child.instanceId)) continue;
      extra += PER_TYPE_FREE_DOF[edge.mate.type] ?? 0;
    }
  }
  return extra;
}
