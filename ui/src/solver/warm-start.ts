// Warm-start + post-solve fixup for fastened mates.
//
// Slvs has no primitive for "Q_B = Q_A · R_fixed", and its 2D-in-workplane
// connector entities project onto the body's xy plane (the connector's
// local Z component is dropped), so POINTS_COINCIDENT can't faithfully
// represent a connector that lives on a face above/below the body's
// origin. Both problems disappear if we keep the fastened follower fully
// outside the solver's hands:
//
//   1. **Warm-start** (pre-solve, `applyFastenedWarmStarts`): pick a
//      driver/follower from each fastened mate, compute the follower's
//      full target pose (origin + quat) analytically, and write it back
//      into the BodyState that buildSystem will consume. Set
//      `lockPosition` and `lockOrientation` so all 7 of the follower's
//      params are placed in GROUP_GROUND — the solver does not touch
//      them, and DOF count is correct (a grounded driver + fastened
//      follower → 0 DOF).
//
//   2. **Fixup** (post-solve, `applyFastenedFixup`): after the solver
//      runs, the driver's pose may have changed (drag, other constraint).
//      Recompute the follower's target from the *solved* driver pose
//      and overwrite `out.bodies[follower]`. State.group then reflects
//      the correct face-to-face relation in every frame.
//
// Driver/follower picking (`pickRoles`):
//   - Two grounded bodies → null (no warm-start; immovable pair, mate is
//     either pre-satisfied or permanently violated).
//   - One grounded → grounded body is driver.
//   - Both free → dragged body is driver if a drag is in flight;
//     otherwise mate-author order picks `connectorA`'s body.
//
// Phase 06 supports trees only. Closed loops or chains require ordering
// the warm-start by graph topology and are deferred.

import { Matrix4, Quaternion, Vector3 } from 'three';
import type { BodyState, ConnectorState, MateRecord, SolvedBody } from './types.js';

/**
 * Revolute warm-start.
 *
 * Like fastened, revolute is solved analytically in JS rather than via
 * slvs. The motivation is the same: slvs's POINT_IN_2D entities project
 * the connector's local Z component to zero, which silently breaks face
 * coincidence for any connector that lives above/below the body's xy
 * plane (top/bottom/side faces — the common case in user-authored parts).
 *
 * Per solve:
 *   1. Pick a driver / follower for each revolute mate.
 *   2. If the follower is being dragged, convert the cursor target into
 *      the corresponding rotation angle about the driver's connector Z
 *      axis. This is what lets the user "spin" the follower with the
 *      mouse without slvs ever seeing a constraint.
 *   3. Recompute the follower's body pose from the (possibly rotated)
 *      orientation so the connector frames meet (face-to-face by default,
 *      back-to-back on `.flip()`, with `.rotate()` as the initial seed
 *      for fresh assemblies).
 *   4. Set `lockPosition` and `lockOrientation` so slvs treats the
 *      follower's params as constants. The 1 free DOF the revolute
 *      contributes is added back to slvs's reported DOF in `Solver.solve()`.
 *
 * The post-solve fixup (`applyRevoluteFixup`) reapplies the analytical
 * relation against the *solved* driver pose so a drag of the driver
 * pulls the follower along.
 */
export type RevoluteDragInfo = {
  draggedInstanceId?: string;
  /** Raw cursor world position on the drag plane. */
  draggedCursorWorld?: Vector3;
  /** Grab point in body-local frame. */
  draggedGrabLocal?: Vector3;
};

export function applyRevoluteWarmStarts(
  bodies: BodyState[],
  mates: MateRecord[],
  drag: RevoluteDragInfo = {},
): void {
  const { draggedInstanceId, draggedCursorWorld, draggedGrabLocal } = drag;
  const byId = new Map(bodies.map(b => [b.instanceId, b]));
  for (const mate of mates) {
    if (mate.type !== 'revolute') continue;
    const aBody = byId.get(mate.connectorA.instanceId);
    const bBody = byId.get(mate.connectorB.instanceId);
    if (!aBody || !bBody) continue;
    const aConn = aBody.connectors.find(c => c.connectorId === mate.connectorA.connectorId);
    const bConn = bBody.connectors.find(c => c.connectorId === mate.connectorB.connectorId);
    if (!aConn || !bConn) continue;

    const roles = pickRoles(aBody, bBody, aConn, bConn, mate, draggedInstanceId, mates);
    if (!roles) continue;
    const { driver, follower, driverConn, followerConn } = roles;
    const options = mate.options ?? {};

    // Initial seed (face-to-face / flipped chirality, plus `.rotate()`
    // angle) only when current pose doesn't satisfy the mate. After that
    // we preserve the orientation across solves so drags are persistent
    // and `.rotate()` truly is a hint, not a snap-back.
    if (!isRevoluteSatisfied(driver, follower, driverConn, followerConn, options)) {
      const seed = computeFastenedTargetPose(driver, driverConn, followerConn, options);
      follower.position = seed.position;
      follower.quaternion = seed.quaternion;
    }

    // Drag-of-cluster: rotate the follower about the pivot Z by the angle
    // that brings the *grab point* to the cursor. The grab point may live
    // on the follower itself, or on any body fastened-connected to it
    // (the rigid cluster pivots as one), so the dragged body counts as
    // long as it's in the follower's fastened cluster. Computing the
    // grab world from the dragged body's pose makes the angle correct
    // for both cases (drag-self and drag-cluster-mate).
    if (
      draggedCursorWorld
      && draggedGrabLocal
      && draggedInstanceId
      && !follower.grounded
    ) {
      const cluster = findFastenedCluster(follower.instanceId, mates);
      if (cluster.has(draggedInstanceId)) {
        const draggedBody = byId.get(draggedInstanceId);
        if (draggedBody) {
          const grabWorld = draggedGrabLocal.clone()
            .applyQuaternion(draggedBody.quaternion)
            .add(draggedBody.position);
          rotateFollowerTowardWorld(
            driver, follower, driverConn, draggedCursorWorld, grabWorld,
          );
        }
      }
    }

    // Re-derive position from the (possibly rotated) orientation so the
    // connector frames truly coincide in world space, regardless of which
    // path set the orientation above.
    follower.position = followerPositionFromOrientation(
      driver, driverConn, followerConn, follower.quaternion, options,
    );

    // Slvs treats revolute followers as constants; the 1 free DOF is
    // added to the reported DOF count by Solver.solve().
    follower.lockPosition = true;
    follower.lockOrientation = true;
  }
}

/**
 * Re-derive each revolute follower's pose from the *solved* driver pose.
 * This is what carries a drag of the driver through to the follower —
 * slvs only saw the driver's params; the follower stayed wherever the
 * warm-start put it. The fixup snaps the follower onto the manifold
 * defined by the now-current driver pose.
 *
 * Runs before the fastened fixup so a chain of revolute → fastened
 * propagates correctly (the fastened side reads the revolute follower's
 * fixed-up pose, not its stale warm-started pose).
 */
export function applyRevoluteFixup(
  inputBodies: BodyState[],
  out: SolvedBody[],
  mates: MateRecord[],
  draggedInstanceId?: string,
): void {
  const inputById = new Map(inputBodies.map(b => [b.instanceId, b]));
  const outById = new Map(out.map(b => [b.instanceId, b]));
  for (const mate of mates) {
    if (mate.type !== 'revolute') continue;
    const aInput = inputById.get(mate.connectorA.instanceId);
    const bInput = inputById.get(mate.connectorB.instanceId);
    if (!aInput || !bInput) continue;
    const aConn = aInput.connectors.find(c => c.connectorId === mate.connectorA.connectorId);
    const bConn = bInput.connectors.find(c => c.connectorId === mate.connectorB.connectorId);
    if (!aConn || !bConn) continue;

    const roles = pickRoles(aInput, bInput, aConn, bConn, mate, draggedInstanceId, mates);
    if (!roles) continue;
    const driverOut = outById.get(roles.driver.instanceId);
    const followerOut = outById.get(roles.follower.instanceId);
    if (!driverOut || !followerOut) continue;

    const driverState: BodyState = {
      ...roles.driver,
      position: driverOut.position,
      quaternion: driverOut.quaternion,
    };
    // Keep the follower's solved orientation (which equals warm-start's
    // because we locked it) and re-derive position from the driver's
    // possibly-updated pose.
    followerOut.position = followerPositionFromOrientation(
      driverState, roles.driverConn, roles.followerConn, followerOut.quaternion,
      mate.options ?? {},
    );
  }
}

const REVOLUTE_EPS = 1e-4;

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
  // The two valid chiralities (parallel vs anti-parallel Z) both count as
  // satisfied here — the chirality is set by the initial seed and
  // preserved by the warm-start preserving the follower's quaternion.
  return Math.abs(Math.abs(fZWorld.dot(dZWorld)) - 1) < REVOLUTE_EPS;
}

/**
 * Rotate the follower about the driver-connector Z axis by the angle
 * that makes the *grab point* track the cursor.
 *
 * Why grab point and not body origin: when the user clicks on a part
 * far from the body's coordinate origin (e.g., the right-hand end of a
 * long bar mated at its center), the body origin and the grab point
 * are on opposite sides of the pivot. A rotation that moves the body
 * origin to "cursor + grabOffset" then moves the grab point in the
 * *opposite* direction along its arc — visibly rotating the body the
 * wrong way under the cursor. Measuring the angle from the grab
 * point's current world position to the cursor's world position
 * eliminates this sign error regardless of where on the body the user
 * grabbed.
 */
/**
 * World-frame variant: rotate the follower about the driver-connector Z
 * axis by the angle that takes `grabWorld` to `cursorWorld` along the
 * arc. `grabWorld` is the current world position of whatever point is
 * being dragged (which may live on the follower or on a body
 * fastened-connected to it).
 */
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

  if (fromInPlane.length() < 1e-9 || toInPlane.length() < 1e-9) {
    return;
  }
  fromInPlane.normalize();
  toInPlane.normalize();

  const cos = Math.min(1, Math.max(-1, fromInPlane.dot(toInPlane)));
  const cross = new Vector3().crossVectors(fromInPlane, toInPlane);
  // Sign of the angle: positive when cross is in the +axis direction.
  const sin = cross.dot(axis);
  const angle = Math.atan2(sin, cos);
  if (Math.abs(angle) < 1e-9) return;

  const dq = new Quaternion().setFromAxisAngle(axis, angle);
  follower.quaternion = dq.multiply(follower.quaternion);
}

/**
 * Returns the follower body position that would make follower-connector
 * world position equal to (driver-connector world position + offset),
 * given a fixed follower orientation.
 */
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

/**
 * Slider warm-start.
 *
 * A slider mate locks 5 of the 6 relative DOFs between two connectors:
 * origins lie on the same line, both Z axes are parallel (face-to-face by
 * default; back-to-back on `.flip()`), both X axes are parallel (or rotated
 * by `.rotate(deg)`). The single free DOF is translation along the shared
 * line.
 *
 * Like fastened and revolute, the entire mate is solved JS-side. The
 * follower's full pose is computed analytically from the driver and the
 * current "slide value" (signed distance along the driver's connector Z
 * axis). Slvs sees both `lockPosition` and `lockOrientation` on the
 * follower and treats it as a known; the 1 free DOF is added back into
 * `out.dof` by `Solver.solve()`.
 *
 * Per solve:
 *   1. Pick a driver / follower for each slider mate (grounded /
 *      already-locked bodies preferred).
 *   2. Determine the effective Z offset (the total signed distance from
 *      driver-connector origin to follower-connector origin along the
 *      driver's Z axis):
 *        - If the mate is currently satisfied (follower-connector origin
 *          lies on the driver's axis line, within ε), preserve the
 *          current slide value so user-dragged offsets persist.
 *        - Otherwise, seed at `options.offset.z` (zero slide + the
 *          author's stop-block constant).
 *   3. If the dragged body is in the follower's fastened cluster,
 *      project the cursor target onto the axis to update the slide
 *      value. Cursor motion perpendicular to the axis is ignored —
 *      that's the line-projection drag behaviour the spec calls for.
 *   4. Recompute the follower's body pose so its connector frame meets
 *      the driver's connector frame at the chosen position along the
 *      axis (with `flip` and `rotate` applied to orientation).
 *   5. Lock both position and orientation.
 *
 * `applySliderFixup` re-runs step 4 after the solver has moved the
 * driver, propagating drag-of-driver motion to the follower while the
 * slide value (read back from the warm-started follower position) is
 * preserved.
 */
export type SliderDragInfo = {
  draggedInstanceId?: string;
  /** Raw cursor world position on the drag plane. */
  draggedCursorWorld?: Vector3;
  /** Grab point in body-local frame. */
  draggedGrabLocal?: Vector3;
};

const SLIDER_EPS = 1e-4;

export function applySliderWarmStarts(
  bodies: BodyState[],
  mates: MateRecord[],
  drag: SliderDragInfo = {},
): void {
  const { draggedInstanceId, draggedCursorWorld, draggedGrabLocal } = drag;
  const byId = new Map(bodies.map(b => [b.instanceId, b]));
  for (const mate of mates) {
    if (mate.type !== 'slider') continue;
    const aBody = byId.get(mate.connectorA.instanceId);
    const bBody = byId.get(mate.connectorB.instanceId);
    if (!aBody || !bBody) continue;
    const aConn = aBody.connectors.find(c => c.connectorId === mate.connectorA.connectorId);
    const bConn = bBody.connectors.find(c => c.connectorId === mate.connectorB.connectorId);
    if (!aConn || !bConn) continue;

    const roles = pickRoles(aBody, bBody, aConn, bConn, mate, draggedInstanceId, mates);
    if (!roles) continue;
    const { driver, follower, driverConn, followerConn } = roles;
    const options = mate.options ?? {};
    const seedOffsetZ = options.offset?.[2] ?? 0;

    let effectiveZ: number;
    if (isSliderOnAxis(driver, follower, driverConn, followerConn)) {
      // Preserve the current slide value across solves so a user drag
      // stays where they left it. The signed distance along the driver Z
      // already includes any author offset, so we read it directly.
      effectiveZ = currentSliderZOffset(driver, driverConn, follower, followerConn);
    } else {
      effectiveZ = seedOffsetZ;
    }

    // Drag-of-cluster: shift the slide value by the axial component of
    // (cursor - grabWorld). The grab point's world position is computed
    // from the dragged body's pose, so this works whether the dragged
    // body is the follower itself or another body fastened to it.
    if (
      draggedCursorWorld
      && draggedGrabLocal
      && draggedInstanceId
      && !follower.grounded
    ) {
      const cluster = findFastenedCluster(follower.instanceId, mates);
      if (cluster.has(draggedInstanceId)) {
        const draggedBody = byId.get(draggedInstanceId);
        if (draggedBody) {
          const grabWorld = draggedGrabLocal.clone()
            .applyQuaternion(draggedBody.quaternion)
            .add(draggedBody.position);
          const axis = driverConn.localNormal.clone()
            .applyQuaternion(driver.quaternion).normalize();
          const delta = draggedCursorWorld.clone().sub(grabWorld).dot(axis);
          effectiveZ += delta;
        }
      }
    }

    const target = computeFastenedTargetPose(driver, driverConn, followerConn, {
      ...options,
      offset: [0, 0, effectiveZ],
    });
    follower.position = target.position;
    follower.quaternion = target.quaternion;
    follower.lockPosition = true;
    follower.lockOrientation = true;
  }
}

/**
 * Re-derive each slider follower's pose from the *solved* driver pose.
 * The slide value is read back from the warm-started follower position
 * (which was mutated in place by `applySliderWarmStarts`), so a drag of
 * the driver carries the follower along the axis with the same relative
 * offset.
 */
export function applySliderFixup(
  inputBodies: BodyState[],
  out: SolvedBody[],
  mates: MateRecord[],
  draggedInstanceId?: string,
): void {
  const inputById = new Map(inputBodies.map(b => [b.instanceId, b]));
  const outById = new Map(out.map(b => [b.instanceId, b]));
  for (const mate of mates) {
    if (mate.type !== 'slider') continue;
    const aInput = inputById.get(mate.connectorA.instanceId);
    const bInput = inputById.get(mate.connectorB.instanceId);
    if (!aInput || !bInput) continue;
    const aConn = aInput.connectors.find(c => c.connectorId === mate.connectorA.connectorId);
    const bConn = bInput.connectors.find(c => c.connectorId === mate.connectorB.connectorId);
    if (!aConn || !bConn) continue;

    const roles = pickRoles(aInput, bInput, aConn, bConn, mate, draggedInstanceId, mates);
    if (!roles) continue;
    const driverOut = outById.get(roles.driver.instanceId);
    const followerOut = outById.get(roles.follower.instanceId);
    if (!driverOut || !followerOut) continue;

    // Read the slide value from the warm-started follower (input) relative
    // to the input driver. The warm-started follower is consistent with
    // the input driver, so projecting back gives the value the warm-start
    // chose (preserved or freshly seeded).
    const effectiveZ = currentSliderZOffset(
      roles.driver, roles.driverConn, roles.follower, roles.followerConn,
    );
    const driverState: BodyState = {
      ...roles.driver,
      position: driverOut.position,
      quaternion: driverOut.quaternion,
    };
    const target = computeFastenedTargetPose(
      driverState, roles.driverConn, roles.followerConn,
      { ...(mate.options ?? {}), offset: [0, 0, effectiveZ] },
    );
    followerOut.position = target.position;
    followerOut.quaternion = target.quaternion;
  }
}

/**
 * Cylindrical warm-start.
 *
 * A cylindrical mate locks 4 of the 6 relative DOFs between two
 * connectors: origins lie on the same line and both Z axes are
 * parallel (face-to-face by default; back-to-back on `.flip()`). The
 * two free DOFs are translation along the shared line **and** rotation
 * about it. Both `.offset(0, 0, d)` and `.rotate(deg)` are *hints*
 * (warm-start seeds), not hard constraints — once the user drags the
 * follower, the running (slide, angle) is preserved across solves.
 *
 * Like the other mates, cylindrical is solved JS-side. The follower's
 * full pose is computed analytically from the driver, the slide value,
 * and the angle; both `lockPosition` and `lockOrientation` are set on
 * the follower so slvs treats it as a constant. The 2 free DOFs are
 * added back into `out.dof` by `Solver.solve()`.
 *
 * Per solve:
 *   1. Pick a driver / follower for each cylindrical mate.
 *   2. Determine the running (slide, angle):
 *        - If the mate is currently satisfied (origin on axis line and
 *          Z parallel/anti-parallel within ε), preserve the current
 *          values so user-applied drags persist.
 *        - Otherwise seed at `options.offset.z` / `options.rotate`.
 *   3. If the dragged body is in the follower's fastened cluster,
 *      decompose `(cursor - grabWorld)` into:
 *        - axial component along the driver Z → adds to slide;
 *        - in-plane rotation about the slid pivot → adds to angle.
 *      Unlike slider's line-projection (perpendicular cursor motion is
 *      ignored), cylindrical absorbs perpendicular motion as rotation —
 *      that's the second DOF.
 *   4. Recompute the follower's pose so its connector frame meets the
 *      driver's connector frame at (slide, angle), with `flip` applied.
 *   5. Lock both position and orientation.
 *
 * `applyCylindricalFixup` re-runs step 4 after the solver moves the
 * driver, propagating drag-of-driver motion to the follower while the
 * (slide, angle) read back from the warm-started follower pose are
 * preserved.
 */
export type CylindricalDragInfo = {
  draggedInstanceId?: string;
  /** Raw cursor world position on the drag plane. */
  draggedCursorWorld?: Vector3;
  /** Grab point in body-local frame. */
  draggedGrabLocal?: Vector3;
};

const CYLINDRICAL_EPS = 1e-4;

export function applyCylindricalWarmStarts(
  bodies: BodyState[],
  mates: MateRecord[],
  drag: CylindricalDragInfo = {},
): void {
  const { draggedInstanceId, draggedCursorWorld, draggedGrabLocal } = drag;
  const byId = new Map(bodies.map(b => [b.instanceId, b]));
  for (const mate of mates) {
    if (mate.type !== 'cylindrical') continue;
    const aBody = byId.get(mate.connectorA.instanceId);
    const bBody = byId.get(mate.connectorB.instanceId);
    if (!aBody || !bBody) continue;
    const aConn = aBody.connectors.find(c => c.connectorId === mate.connectorA.connectorId);
    const bConn = bBody.connectors.find(c => c.connectorId === mate.connectorB.connectorId);
    if (!aConn || !bConn) continue;

    const roles = pickRoles(aBody, bBody, aConn, bConn, mate, draggedInstanceId, mates);
    if (!roles) continue;
    const { driver, follower, driverConn, followerConn } = roles;
    const options = mate.options ?? {};
    const seedSlide = options.offset?.[2] ?? 0;
    const seedAngle = options.rotate ?? 0;

    let slide: number;
    let angle: number;
    if (isCylindricalSatisfied(driver, follower, driverConn, followerConn)) {
      const state = currentCylindricalState(
        driver, follower, driverConn, followerConn,
      );
      slide = state.slide;
      angle = state.angle;
    } else {
      slide = seedSlide;
      angle = seedAngle;
    }

    // Drag-of-cluster: split (cursor - grabWorld) into axial (slide
    // delta) and in-plane (angle delta) components. The grab point's
    // world position is computed from the dragged body's pose, so this
    // works whether the dragged body is the follower itself or another
    // body fastened to it.
    if (
      draggedCursorWorld
      && draggedGrabLocal
      && draggedInstanceId
      && !follower.grounded
    ) {
      const cluster = findFastenedCluster(follower.instanceId, mates);
      if (cluster.has(draggedInstanceId)) {
        const draggedBody = byId.get(draggedInstanceId);
        if (draggedBody) {
          const grabWorld = draggedGrabLocal.clone()
            .applyQuaternion(draggedBody.quaternion)
            .add(draggedBody.position);
          const dOrigin = driverConn.localOrigin.clone()
            .applyQuaternion(driver.quaternion).add(driver.position);
          const dZ = driverConn.localNormal.clone()
            .applyQuaternion(driver.quaternion).normalize();

          const axialDelta = draggedCursorWorld.clone().sub(grabWorld).dot(dZ);
          slide += axialDelta;

          // After the slide, the grab moves with the body by `axialDelta * dZ`.
          // Compute the in-plane rotation about the slid pivot that takes
          // grabAfterSlide → cursor. Same arc-angle formulation as revolute.
          const grabAfterSlide = grabWorld.clone().addScaledVector(dZ, axialDelta);
          const pivotAfterSlide = dOrigin.clone().addScaledVector(dZ, slide);
          const fromVec = grabAfterSlide.clone().sub(pivotAfterSlide);
          const toVec = draggedCursorWorld.clone().sub(pivotAfterSlide);
          const fromInPlane = fromVec.clone()
            .sub(dZ.clone().multiplyScalar(fromVec.dot(dZ)));
          const toInPlane = toVec.clone()
            .sub(dZ.clone().multiplyScalar(toVec.dot(dZ)));
          if (fromInPlane.length() > 1e-9 && toInPlane.length() > 1e-9) {
            fromInPlane.normalize();
            toInPlane.normalize();
            const cos = Math.min(1, Math.max(-1, fromInPlane.dot(toInPlane)));
            const sin = new Vector3()
              .crossVectors(fromInPlane, toInPlane).dot(dZ);
            const angleDeltaRad = Math.atan2(sin, cos);
            angle += (angleDeltaRad * 180) / Math.PI;
          }
        }
      }
    }

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
}

/**
 * Re-derive each cylindrical follower's pose from the *solved* driver
 * pose. The (slide, angle) values are read back from the warm-started
 * follower pose (which was mutated in place), so a drag of the driver
 * carries the follower along the axis with the same relative offset
 * and angle.
 */
export function applyCylindricalFixup(
  inputBodies: BodyState[],
  out: SolvedBody[],
  mates: MateRecord[],
  draggedInstanceId?: string,
): void {
  const inputById = new Map(inputBodies.map(b => [b.instanceId, b]));
  const outById = new Map(out.map(b => [b.instanceId, b]));
  for (const mate of mates) {
    if (mate.type !== 'cylindrical') continue;
    const aInput = inputById.get(mate.connectorA.instanceId);
    const bInput = inputById.get(mate.connectorB.instanceId);
    if (!aInput || !bInput) continue;
    const aConn = aInput.connectors.find(c => c.connectorId === mate.connectorA.connectorId);
    const bConn = bInput.connectors.find(c => c.connectorId === mate.connectorB.connectorId);
    if (!aConn || !bConn) continue;

    const roles = pickRoles(aInput, bInput, aConn, bConn, mate, draggedInstanceId, mates);
    if (!roles) continue;
    const driverOut = outById.get(roles.driver.instanceId);
    const followerOut = outById.get(roles.follower.instanceId);
    if (!driverOut || !followerOut) continue;

    const state = currentCylindricalState(
      roles.driver, roles.follower, roles.driverConn, roles.followerConn,
    );
    const driverState: BodyState = {
      ...roles.driver,
      position: driverOut.position,
      quaternion: driverOut.quaternion,
    };
    const target = computeFastenedTargetPose(
      driverState, roles.driverConn, roles.followerConn,
      {
        flip: mate.options?.flip,
        rotate: state.angle,
        offset: [0, 0, state.slide],
      },
    );
    followerOut.position = target.position;
    followerOut.quaternion = target.quaternion;
  }
}

/**
 * True iff the follower's connector origin lies on the driver's
 * connector Z axis line (perpendicular distance < ε) AND their Z axes
 * are parallel or anti-parallel within ε. Used to decide whether
 * (slide, angle) read from the current state are meaningful or we need
 * to seed from `.offset` / `.rotate`.
 */
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

/**
 * Extract the running (slide, angle) of a cylindrical mate from the
 * current driver/follower poses. `slide` is the signed distance along
 * the driver's connector Z axis from driver origin to follower origin.
 * `angle` (degrees) is the rotation about the driver Z that maps
 * driver's connector X to the follower's connector X (after projecting
 * follower X into the plane perpendicular to driver Z so that .flip()
 * doesn't perturb the reading).
 */
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

  // Project follower X into the plane perpendicular to driver Z.
  // computeFastenedTargetPose re-orthogonalizes targetX against targetZ
  // (which is ±dZ depending on flip), and dZ is perpendicular to dX, so
  // the resulting targetX always lies in the dZ-perp plane; reading
  // the angle there cancels the .flip() sign.
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

/**
 * True iff the follower's connector origin lies on the driver's connector
 * Z axis line (perpendicular distance < ε). Orientation is intentionally
 * not checked — the slider warm-start always re-imposes orientation from
 * the driver, so any drift would be corrected anyway. The point of this
 * check is to decide whether the *slide value* is meaningful or we need
 * to seed from `options.offset.z` for a fresh assembly.
 */
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

/** Signed distance from driver-connector origin to follower-connector
 *  origin along the driver's connector Z axis (in world). Positive when
 *  follower is on the +Z side of driver. Caller guarantees the follower
 *  is on-axis (otherwise the perpendicular component is silently lost). */
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

/**
 * Planar warm-start.
 *
 * A planar mate locks 3 of the 6 relative DOFs between two connectors:
 * the follower-connector origin lies in the driver's connector XY
 * plane (or, with `.offset(0, 0, d)`, in the plane parallel-shifted by
 * `d` along the driver's Z), and the two Z axes are parallel
 * (face-to-face by default; back-to-back on `.flip()`). The 3 free
 * DOFs are 2 in-plane translations + 1 rotation about the shared Z.
 *
 * `.offset(0, 0, d)` is a *hard* constant — the plane gap stays at
 * `d` regardless of drag (matches the spec: "lifts the book a fixed
 * distance above the table"). XY components are forbidden upstream
 * in `MateBuilder.offset()`. `.rotate(deg)` is a *hint* that seeds
 * the angle when the mate isn't currently satisfied.
 *
 * Like the other mates, planar is solved JS-side. The follower's
 * full pose is computed analytically as
 * `computeFastenedTargetPose(driver, ..., { rotate: angle,
 * offset: [xLocal, yLocal, d], flip })` and both `lockPosition` and
 * `lockOrientation` are set; the 3 free DOFs are added back into
 * `out.dof` by `Solver.solve()`.
 *
 * Drag-of-cluster is handled by translating the follower in-plane so
 * the grab tracks the cursor's projection onto the plane: `(cursor −
 * grabWorld)` is decomposed onto the driver's connector X and Y axes
 * and added to `(xLocal, yLocal)`. Cursor motion perpendicular to
 * the plane is ignored — that's the "snap cursor onto the shared
 * plane" projection the spec calls for. Rotation-by-drag is not
 * derived from cursor motion in this phase (3 DOFs vs 2 cursor DOFs
 * after projection); a Shift-modifier rotate-only mode is listed as
 * a follow-up alongside cylindrical's.
 */
export type PlanarDragInfo = {
  draggedInstanceId?: string;
  /** Raw cursor world position on the drag plane. */
  draggedCursorWorld?: Vector3;
  /** Grab point in body-local frame. */
  draggedGrabLocal?: Vector3;
};

const PLANAR_EPS = 1e-4;

export function applyPlanarWarmStarts(
  bodies: BodyState[],
  mates: MateRecord[],
  drag: PlanarDragInfo = {},
): void {
  const { draggedInstanceId, draggedCursorWorld, draggedGrabLocal } = drag;
  const byId = new Map(bodies.map(b => [b.instanceId, b]));
  for (const mate of mates) {
    if (mate.type !== 'planar') continue;
    const aBody = byId.get(mate.connectorA.instanceId);
    const bBody = byId.get(mate.connectorB.instanceId);
    if (!aBody || !bBody) continue;
    const aConn = aBody.connectors.find(c => c.connectorId === mate.connectorA.connectorId);
    const bConn = bBody.connectors.find(c => c.connectorId === mate.connectorB.connectorId);
    if (!aConn || !bConn) continue;

    const roles = pickRoles(aBody, bBody, aConn, bConn, mate, draggedInstanceId, mates);
    if (!roles) continue;
    const { driver, follower, driverConn, followerConn } = roles;
    const options = mate.options ?? {};
    const dz = options.offset?.[2] ?? 0;
    const seedAngle = options.rotate ?? 0;

    let xLocal: number;
    let yLocal: number;
    let angle: number;
    if (isPlanarSatisfied(driver, follower, driverConn, followerConn, dz)) {
      // Mate currently satisfied — preserve the running (x, y, angle) so
      // user drags persist across solves.
      const state = currentPlanarState(
        driver, follower, driverConn, followerConn, dz,
      );
      xLocal = state.x;
      yLocal = state.y;
      angle = state.angle;
    } else {
      xLocal = 0;
      yLocal = 0;
      angle = seedAngle;
    }

    // Drag-of-cluster: translate the follower in-plane so the grab tracks
    // the cursor's projection onto the plane. The grab point's world
    // position is computed from the dragged body's pose, so this works
    // whether the dragged body is the follower itself or another body
    // fastened to it.
    if (
      draggedCursorWorld
      && draggedGrabLocal
      && draggedInstanceId
      && !follower.grounded
    ) {
      const cluster = findFastenedCluster(follower.instanceId, mates);
      if (cluster.has(draggedInstanceId)) {
        const draggedBody = byId.get(draggedInstanceId);
        if (draggedBody) {
          const grabWorld = draggedGrabLocal.clone()
            .applyQuaternion(draggedBody.quaternion)
            .add(draggedBody.position);
          const dX = driverConn.localXDirection.clone()
            .applyQuaternion(driver.quaternion).normalize();
          const dZ = driverConn.localNormal.clone()
            .applyQuaternion(driver.quaternion).normalize();
          const dY = new Vector3().crossVectors(dZ, dX).normalize();
          const delta = draggedCursorWorld.clone().sub(grabWorld);
          xLocal += delta.dot(dX);
          yLocal += delta.dot(dY);
        }
      }
    }

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
}

/**
 * Re-derive each planar follower's pose from the *solved* driver pose.
 * The (x, y, angle) values are read back from the warm-started follower
 * pose (which was mutated in place), so a drag of the driver carries
 * the follower in-plane with the same relative offset and angle.
 */
export function applyPlanarFixup(
  inputBodies: BodyState[],
  out: SolvedBody[],
  mates: MateRecord[],
  draggedInstanceId?: string,
): void {
  const inputById = new Map(inputBodies.map(b => [b.instanceId, b]));
  const outById = new Map(out.map(b => [b.instanceId, b]));
  for (const mate of mates) {
    if (mate.type !== 'planar') continue;
    const aInput = inputById.get(mate.connectorA.instanceId);
    const bInput = inputById.get(mate.connectorB.instanceId);
    if (!aInput || !bInput) continue;
    const aConn = aInput.connectors.find(c => c.connectorId === mate.connectorA.connectorId);
    const bConn = bInput.connectors.find(c => c.connectorId === mate.connectorB.connectorId);
    if (!aConn || !bConn) continue;

    const roles = pickRoles(aInput, bInput, aConn, bConn, mate, draggedInstanceId, mates);
    if (!roles) continue;
    const driverOut = outById.get(roles.driver.instanceId);
    const followerOut = outById.get(roles.follower.instanceId);
    if (!driverOut || !followerOut) continue;

    const dz = mate.options?.offset?.[2] ?? 0;
    const state = currentPlanarState(
      roles.driver, roles.follower, roles.driverConn, roles.followerConn, dz,
    );
    const driverState: BodyState = {
      ...roles.driver,
      position: driverOut.position,
      quaternion: driverOut.quaternion,
    };
    const target = computeFastenedTargetPose(
      driverState, roles.driverConn, roles.followerConn,
      {
        flip: mate.options?.flip,
        rotate: state.angle,
        offset: [state.x, state.y, dz],
      },
    );
    followerOut.position = target.position;
    followerOut.quaternion = target.quaternion;
  }
}

/**
 * True iff the follower's connector origin lies in the driver's connector
 * plane (origin shifted by `dz` along driver Z), within ε perpendicular,
 * AND the two Z axes are parallel or anti-parallel within ε. Used to
 * decide whether the running (x, y, angle) read from the current state
 * is meaningful or we need to seed from `options.rotate`.
 */
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

/**
 * Extract the running (x, y, angle) of a planar mate from the current
 * driver/follower poses. `(x, y)` is the follower-connector origin's
 * offset from the (potentially Z-shifted) driver-connector origin,
 * measured in the driver's connector X/Y axes. `angle` (degrees) is
 * the rotation about the driver Z that maps driver's connector X to
 * the follower's connector X, after projecting follower X into the
 * plane perpendicular to driver Z so `.flip()` doesn't perturb the
 * reading.
 */
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

/**
 * Mutates each follower body in `bodies` so its pose is consistent with
 * its driver's pose under the fastened mate semantics. Sets
 * `lockOrientation = true` on every follower so the solver freezes its
 * quaternion params.
 */
export function applyFastenedWarmStarts(
  bodies: BodyState[],
  mates: MateRecord[],
  draggedInstanceId?: string,
): void {
  const byId = new Map(bodies.map(b => [b.instanceId, b]));
  for (const mate of mates) {
    if (mate.type !== 'fastened') continue;
    const aBody = byId.get(mate.connectorA.instanceId);
    const bBody = byId.get(mate.connectorB.instanceId);
    if (!aBody || !bBody) continue;
    const aConn = aBody.connectors.find(c => c.connectorId === mate.connectorA.connectorId);
    const bConn = bBody.connectors.find(c => c.connectorId === mate.connectorB.connectorId);
    if (!aConn || !bConn) continue;

    const roles = pickRoles(
      aBody, bBody, aConn, bConn, mate, draggedInstanceId, mates,
    );
    if (!roles) continue;
    const { driver, follower, driverConn, followerConn } = roles;

    const target = computeFastenedTargetPose(
      driver, driverConn, followerConn, mate.options ?? {},
    );
    follower.position = target.position;
    follower.quaternion = target.quaternion;
    follower.lockPosition = true;
    follower.lockOrientation = true;
  }
}

/**
 * After the solver runs, the driver's pose may have moved (a drag pin or
 * another constraint resolved its position). Recompute each follower's
 * pose from the SOLVED driver pose and overwrite the corresponding entry
 * in `out`. This is what keeps a fastened pair rigid during a drag — the
 * follower tracks the driver every frame, regardless of whether slvs
 * happened to look at the constraint.
 */
export function applyFastenedFixup(
  inputBodies: BodyState[],
  out: SolvedBody[],
  mates: MateRecord[],
  draggedInstanceId?: string,
): void {
  const inputById = new Map(inputBodies.map(b => [b.instanceId, b]));
  const outById = new Map(out.map(b => [b.instanceId, b]));
  for (const mate of mates) {
    if (mate.type !== 'fastened') continue;
    const aInput = inputById.get(mate.connectorA.instanceId);
    const bInput = inputById.get(mate.connectorB.instanceId);
    if (!aInput || !bInput) continue;
    const aConn = aInput.connectors.find(c => c.connectorId === mate.connectorA.connectorId);
    const bConn = bInput.connectors.find(c => c.connectorId === mate.connectorB.connectorId);
    if (!aConn || !bConn) continue;

    const roles = pickRoles(aInput, bInput, aConn, bConn, mate, draggedInstanceId, mates);
    if (!roles) continue;
    const driverOut = outById.get(roles.driver.instanceId);
    const followerOut = outById.get(roles.follower.instanceId);
    if (!driverOut || !followerOut) continue;

    // Re-derive the follower's pose from the driver's solved pose. The
    // driver's solved pose may differ from its input pose if a drag pin
    // or another constraint moved it.
    const driverState: BodyState = {
      ...roles.driver,
      position: driverOut.position,
      quaternion: driverOut.quaternion,
    };
    const target = computeFastenedTargetPose(
      driverState, roles.driverConn, roles.followerConn, mate.options ?? {},
    );
    followerOut.position = target.position;
    followerOut.quaternion = target.quaternion;
  }
}

type Roles = {
  driver: BodyState;
  follower: BodyState;
  driverConn: ConnectorState;
  followerConn: ConnectorState;
};

function pickRoles(
  aBody: BodyState,
  bBody: BodyState,
  aConn: ConnectorState,
  bConn: ConnectorState,
  mate: MateRecord,
  draggedInstanceId?: string,
  allMates?: MateRecord[],
): Roles | null {
  // Grounded bodies are immovable and must always be drivers. Two grounded
  // bodies have nothing to warm-start (the mate is either pre-satisfied or
  // permanently violated; the latter is detected separately).
  if (aBody.grounded && bBody.grounded) {
    return null;
  }
  if (aBody.grounded) {
    return { driver: aBody, follower: bBody, driverConn: aConn, followerConn: bConn };
  }
  if (bBody.grounded) {
    return { driver: bBody, follower: aBody, driverConn: bConn, followerConn: aConn };
  }

  // Constraint-aware role pick for fastened: a body that has a non-fastened
  // mate (e.g. revolute) is more constrained than one that doesn't, and
  // should drive the fastened pair so the rigid cluster pivots correctly.
  // Without this, a chain like "i1 grounded → revolute → i2 → fastened →
  // i3", when the user drags i3, would pick i3 as the fastened driver
  // (drag-aware tiebreak), and the fastened fixup would clobber the
  // revolute relation with i2 → i3 ends up moving freely instead of
  // rotating around i1's pivot.
  if (mate.type === 'fastened' && allMates) {
    const aHasOther = hasNonFastenedMateOther(aBody.instanceId, mate.mateId, allMates);
    const bHasOther = hasNonFastenedMateOther(bBody.instanceId, mate.mateId, allMates);
    if (aHasOther && !bHasOther) {
      return { driver: aBody, follower: bBody, driverConn: aConn, followerConn: bConn };
    }
    if (bHasOther && !aHasOther) {
      return { driver: bBody, follower: aBody, driverConn: bConn, followerConn: aConn };
    }
  }

  // Neither grounded, no constraint-asymmetry signal: the dragged body
  // is the driver, since the user is steering it. With no drag,
  // mate-author order picks A as driver.
  if (draggedInstanceId === bBody.instanceId) {
    return { driver: bBody, follower: aBody, driverConn: bConn, followerConn: aConn };
  }
  return { driver: aBody, follower: bBody, driverConn: aConn, followerConn: bConn };
}

/**
 * True if `instanceId` participates in any mate other than `excludeMateId`
 * whose type isn't fastened. Used by `pickRoles` to give bodies with
 * external (non-fastened) constraints priority as the fastened driver.
 */
function hasNonFastenedMateOther(
  instanceId: string,
  excludeMateId: string,
  mates: MateRecord[],
): boolean {
  for (const m of mates) {
    if (m.mateId === excludeMateId) continue;
    if (m.type === 'fastened') continue;
    if (m.connectorA.instanceId === instanceId
        || m.connectorB.instanceId === instanceId) {
      return true;
    }
  }
  return false;
}

/**
 * Set of instance ids that are fastened-connected to `rootId` (transitively).
 * A fastened cluster moves as a single rigid body, so a drag of any cluster
 * member is equivalent to dragging the cluster as a whole — relevant for
 * revolute warm-start, where the dragged body need not be the revolute
 * follower itself for the rotation to apply.
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
  // Driver's connector world frame.
  const dOriginWorld = driverConn.localOrigin.clone()
    .applyQuaternion(driver.quaternion)
    .add(driver.position);
  const dXWorld = driverConn.localXDirection.clone()
    .applyQuaternion(driver.quaternion).normalize();
  const dZWorld = driverConn.localNormal.clone()
    .applyQuaternion(driver.quaternion).normalize();
  const dYWorld = new Vector3().crossVectors(dZWorld, dXWorld).normalize();

  // Optional offset: shift the target origin in the driver-connector frame.
  let targetOriginWorld = dOriginWorld.clone();
  if (options.offset) {
    const [ox, oy, oz] = options.offset;
    targetOriginWorld
      .addScaledVector(dXWorld, ox)
      .addScaledVector(dYWorld, oy)
      .addScaledVector(dZWorld, oz);
  }

  // Default fastened semantics is face-to-face: follower's Z = -driver's Z.
  // .flip() toggles to back-to-back (Z parallel) for cases where the user
  // explicitly wants that.
  const faceToFace = !options.flip;
  const targetZ = faceToFace ? dZWorld.clone().negate() : dZWorld.clone();

  // Rotate driver X around the driver Z axis by `rotate` degrees. The
  // follower's X should land there. Rotating around dZ rather than targetZ
  // matches Onshape semantics — flip is "anti-parallel Z" only, not a
  // re-axis of the rotation.
  let targetX = dXWorld.clone();
  if (options.rotate) {
    targetX.applyAxisAngle(dZWorld, options.rotate * Math.PI / 180);
  }
  // Re-orthogonalize against targetZ in case targetZ flipped the chirality.
  targetX.sub(targetZ.clone().multiplyScalar(targetX.dot(targetZ))).normalize();
  const targetY = new Vector3().crossVectors(targetZ, targetX).normalize();

  const targetMatrix = new Matrix4().makeBasis(targetX, targetY, targetZ);

  // Follower's local frame as a basis matrix.
  const fLocalY = new Vector3().crossVectors(followerConn.localNormal, followerConn.localXDirection).normalize();
  const fLocalMatrix = new Matrix4().makeBasis(
    followerConn.localXDirection.clone().normalize(),
    fLocalY,
    followerConn.localNormal.clone().normalize(),
  );

  // body_quat = target_world * follower_local^(-1) (rotation transpose).
  const fLocalInverse = fLocalMatrix.clone().transpose();
  const bodyMatrix = new Matrix4().multiplyMatrices(targetMatrix, fLocalInverse);
  const bodyQuat = new Quaternion().setFromRotationMatrix(bodyMatrix);

  // body_pos = target_origin - body_quat · follower.localOrigin.
  const localOriginRotated = followerConn.localOrigin.clone().applyQuaternion(bodyQuat);
  const bodyPos = targetOriginWorld.clone().sub(localOriginRotated);

  return { position: bodyPos, quaternion: bodyQuat };
}
