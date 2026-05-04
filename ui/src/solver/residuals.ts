// Per-mate residual functions for the LM relaxation pass.
//
// A residual function takes the current pose of two bodies (driver and
// follower) and returns a vector that's zero iff the mate is satisfied.
// Higher residual norm = more violation. The LM driver minimizes the
// sum of squares across all residuals in a loop component.
//
// Residuals are pure: same input → same output, no scene-graph state,
// no slvs. They're reused both as the LM cost (during relaxation) and
// as a post-LM consistency check (for the joints panel red dots in
// stage 5).
//
// Stage 2 ships only `residualRevolute` and `residualDrag`; later
// stages add fastened, slider, cylindrical, planar.

import { Quaternion, Vector3 } from 'three';
import type { BodyState, ConnectorState } from './types.js';
import { computeFastenedTargetPose } from './warm-start.js';

export type MateOptions = {
  rotate?: number;
  flip?: boolean;
  offset?: [number, number, number];
};

/**
 * Revolute residual (5 components):
 *   [0..2] position: follower-connector world origin minus driver-connector
 *          world origin (with optional offset). Zero iff origins coincide.
 *   [3..4] axis parallelism: projection of follower-connector world Z onto
 *          the driver's connector X and Y axes. Zero iff fZ is parallel
 *          (or anti-parallel) to dZ.
 *
 * The 2D parallelism residual is satisfied for both `fZ = +dZ` (flip)
 * and `fZ = -dZ` (face-to-face). Chirality is set by the warm-start
 * before LM runs; LM stays on whichever side it's already on because
 * the gradient pulls toward the nearest minimum.
 */
export function residualRevolute(
  driver: BodyState,
  follower: BodyState,
  driverConn: ConnectorState,
  followerConn: ConnectorState,
  options: MateOptions = {},
): number[] {
  const dOriginWorld = driverConn.localOrigin.clone()
    .applyQuaternion(driver.quaternion).add(driver.position);
  const dXWorld = driverConn.localXDirection.clone()
    .applyQuaternion(driver.quaternion).normalize();
  const dZWorld = driverConn.localNormal.clone()
    .applyQuaternion(driver.quaternion).normalize();
  const dYWorld = new Vector3().crossVectors(dZWorld, dXWorld).normalize();

  let target = dOriginWorld;
  if (options.offset) {
    const [ox, oy, oz] = options.offset;
    target = dOriginWorld.clone()
      .addScaledVector(dXWorld, ox)
      .addScaledVector(dYWorld, oy)
      .addScaledVector(dZWorld, oz);
  }

  const fOriginWorld = followerConn.localOrigin.clone()
    .applyQuaternion(follower.quaternion).add(follower.position);
  const fZWorld = followerConn.localNormal.clone()
    .applyQuaternion(follower.quaternion).normalize();

  const dx = fOriginWorld.x - target.x;
  const dy = fOriginWorld.y - target.y;
  const dz = fOriginWorld.z - target.z;
  // Axis parallelism: 2 perpendicular components of fZ in driver basis.
  const ax = fZWorld.dot(dXWorld);
  const ay = fZWorld.dot(dYWorld);
  return [dx, dy, dz, ax, ay];
}

/**
 * Fastened residual (6 components): 3 position + 3 orientation. Zero
 * iff the follower body sits at exactly the pose
 * `computeFastenedTargetPose` would have produced — i.e., connector
 * frames coincide face-to-face (or back-to-back on `.flip()`) with
 * the optional `.rotate()` and `.offset()` applied.
 *
 * Position residual: `follower.position - target.position`.
 * Orientation residual: axis-angle vector of `target.quat⁻¹ · follower.quat`,
 * which is zero iff the two quaternions agree up to sign.
 */
export function residualFastened(
  driver: BodyState,
  follower: BodyState,
  driverConn: ConnectorState,
  followerConn: ConnectorState,
  options: MateOptions = {},
): number[] {
  const target = computeFastenedTargetPose(
    driver, driverConn, followerConn, options,
  );
  const dpx = follower.position.x - target.position.x;
  const dpy = follower.position.y - target.position.y;
  const dpz = follower.position.z - target.position.z;
  const ang = quatLog2(
    target.quaternion.clone().invert().multiply(follower.quaternion),
  );
  return [dpx, dpy, dpz, ang.x, ang.y, ang.z];
}

/**
 * Slider residual (5 components):
 *   [0..1] position perpendicular to driver Z (2 components — slide
 *          along Z is the 1 free DOF).
 *   [2..4] orientation as axis-angle of `target.quat⁻¹ · follower.quat`,
 *          where `target` is `computeFastenedTargetPose` with the slide
 *          offset omitted (orientation is independent of slide).
 *
 * `.rotate(deg)` is a hard lock for slider; the target quat reflects
 * it, so any deviation enters the orientation residual.
 */
export function residualSlider(
  driver: BodyState,
  follower: BodyState,
  driverConn: ConnectorState,
  followerConn: ConnectorState,
  options: MateOptions = {},
): number[] {
  const dOriginWorld = driverConn.localOrigin.clone()
    .applyQuaternion(driver.quaternion).add(driver.position);
  const dXWorld = driverConn.localXDirection.clone()
    .applyQuaternion(driver.quaternion).normalize();
  const dZWorld = driverConn.localNormal.clone()
    .applyQuaternion(driver.quaternion).normalize();
  const dYWorld = new Vector3().crossVectors(dZWorld, dXWorld).normalize();

  const fOriginWorld = followerConn.localOrigin.clone()
    .applyQuaternion(follower.quaternion).add(follower.position);
  const diff = fOriginWorld.sub(dOriginWorld);

  // Position residual: 2 perpendicular components (along dX, dY). The
  // axial component is the slider's free DOF.
  const px = diff.dot(dXWorld);
  const py = diff.dot(dYWorld);

  // Orientation residual: target frame as if the slide were zero. Any
  // residual along Z gets folded into the axis-angle vector — slider
  // locks rotation, so any in-plane misalignment shows up.
  const target = computeFastenedTargetPose(
    driver, driverConn, followerConn,
    { flip: options.flip, rotate: options.rotate },
  );
  const ang = quatLog2(
    target.quaternion.clone().invert().multiply(follower.quaternion),
  );
  return [px, py, ang.x, ang.y, ang.z];
}

/**
 * Cylindrical residual (4 components):
 *   [0..1] position perpendicular to driver Z (2 components — slide
 *          along Z is one of the 2 free DOFs).
 *   [2..3] axis parallelism: projection of follower-connector world Z
 *          onto driver X and Y. Zero iff fZ is parallel/anti-parallel
 *          to dZ.
 *
 * Rotation about Z is the second free DOF; cylindrical residual does
 * not constrain it.
 */
export function residualCylindrical(
  driver: BodyState,
  follower: BodyState,
  driverConn: ConnectorState,
  followerConn: ConnectorState,
  _options: MateOptions = {},
): number[] {
  const dOriginWorld = driverConn.localOrigin.clone()
    .applyQuaternion(driver.quaternion).add(driver.position);
  const dXWorld = driverConn.localXDirection.clone()
    .applyQuaternion(driver.quaternion).normalize();
  const dZWorld = driverConn.localNormal.clone()
    .applyQuaternion(driver.quaternion).normalize();
  const dYWorld = new Vector3().crossVectors(dZWorld, dXWorld).normalize();

  const fOriginWorld = followerConn.localOrigin.clone()
    .applyQuaternion(follower.quaternion).add(follower.position);
  const fZWorld = followerConn.localNormal.clone()
    .applyQuaternion(follower.quaternion).normalize();
  const diff = fOriginWorld.sub(dOriginWorld);

  return [
    diff.dot(dXWorld),
    diff.dot(dYWorld),
    fZWorld.dot(dXWorld),
    fZWorld.dot(dYWorld),
  ];
}

/**
 * Planar residual (3 components):
 *   [0]    position along driver Z minus the .offset(0,0,d) lift.
 *          Zero iff follower-connector origin lies in the plane.
 *   [1..2] axis parallelism: projection of follower-connector world Z
 *          onto driver X and Y. Zero iff fZ is parallel/anti-parallel
 *          to dZ.
 *
 * The 3 free DOFs (in-plane translation × 2 + rotation about Z) are
 * intentionally unconstrained by the residual.
 */
export function residualPlanar(
  driver: BodyState,
  follower: BodyState,
  driverConn: ConnectorState,
  followerConn: ConnectorState,
  options: MateOptions = {},
): number[] {
  const dOriginWorld = driverConn.localOrigin.clone()
    .applyQuaternion(driver.quaternion).add(driver.position);
  const dXWorld = driverConn.localXDirection.clone()
    .applyQuaternion(driver.quaternion).normalize();
  const dZWorld = driverConn.localNormal.clone()
    .applyQuaternion(driver.quaternion).normalize();
  const dYWorld = new Vector3().crossVectors(dZWorld, dXWorld).normalize();

  const dz = options.offset?.[2] ?? 0;
  const planeOrigin = dOriginWorld.addScaledVector(dZWorld, dz);
  const fOriginWorld = followerConn.localOrigin.clone()
    .applyQuaternion(follower.quaternion).add(follower.position);
  const fZWorld = followerConn.localNormal.clone()
    .applyQuaternion(follower.quaternion).normalize();
  const diff = fOriginWorld.sub(planeOrigin);

  return [
    diff.dot(dZWorld),
    fZWorld.dot(dXWorld),
    fZWorld.dot(dYWorld),
  ];
}

/**
 * Drag residual (3 components): grab world position minus cursor world
 * position. Zero iff the body's grab point sits at the cursor target.
 *
 * Used in the LM cost when the dragged body is in a loop component, so
 * the cursor pin enters as a soft constraint that competes with the
 * closure mates. Stage 4 will tune the weighting for closure-vs-drag
 * priority when the cursor target is unreachable.
 */
export function residualDrag(
  body: BodyState,
  grabLocal: Vector3,
  cursorWorld: Vector3,
): number[] {
  const grabWorld = grabLocal.clone()
    .applyQuaternion(body.quaternion)
    .add(body.position);
  return [
    grabWorld.x - cursorWorld.x,
    grabWorld.y - cursorWorld.y,
    grabWorld.z - cursorWorld.z,
  ];
}

/**
 * 2 · log(q) — the axis-angle vector of unit quaternion `q`. Zero iff
 * q is the identity rotation (q.w = ±1, q.xyz = 0). Used as a 3D
 * orientation residual that's smooth through the identity.
 *
 * For unit q with `q.w ≈ 1` (small angle): ≈ 2·(q.x, q.y, q.z).
 * Generally: angle = 2·atan2(|q.xyz|, q.w), axis = q.xyz / |q.xyz|,
 * result = angle · axis = 2·q.xyz·atan2(|q.xyz|, q.w) / |q.xyz|.
 */
function quatLog2(q: Quaternion): Vector3 {
  const xyz = new Vector3(q.x, q.y, q.z);
  const xyzLen = xyz.length();
  if (xyzLen < 1e-12) {
    return new Vector3(0, 0, 0);
  }
  // atan2 takes the sign of q.w into account; for q.w < 0, the rotation
  // is parameterized "the long way around" — flip to the short way so
  // the residual reads small for nearly-identical orientations.
  const w = q.w < 0 ? -q.w : q.w;
  const sign = q.w < 0 ? -1 : 1;
  const angle = 2 * Math.atan2(xyzLen, w);
  return xyz.multiplyScalar((sign * angle) / xyzLen);
}
