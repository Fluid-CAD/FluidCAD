// Per-mate misclosure report — the human-readable side of `failed[]`.
//
// The residual rows (joint-model.ts / contact-model.ts) are what the LM
// minimizes: mixed units, orientation rows scaled by ORIENTATION_WEIGHT,
// fastened rows in body-origin space. They tell the solver *that* a mate
// is open, not *where*. A failing closure edge also carries the whole
// loop's misclosure, so the user needs the gap expressed in terms they
// can chase back to a connector: "6.0 mm along Y" points straight at the
// connector whose coordinate is off, where "residual 6.000" does not.
//
// `mateGap` re-measures the mate at the solved poses in the follower
// connector's terms: the connector-origin gap along the CONSTRAINED
// directions only (a slider's free slide never counts), mapped back to
// WORLD axes, plus the orientation error in degrees.

import { Vector3 } from 'three';
import type { BodyState, ConnectorState, MateFailure, MateRecord, WorldAxis } from './types.js';
import {
  JOINT_SPECS,
  computeFastenedTargetPose,
  defaultParams,
  quatLog2,
  type MateOptions,
  type MateType,
} from './joint-model.js';
import { contactGap, type ResolvedContact } from './contact-model.js';

export type { MateFailure, WorldAxis };

/**
 * Fraction of the gap length one world axis must carry to be named
 * (`MateFailure.gapAxis`). Contact mates report a scalar surface gap with
 * no axis.
 */
const AXIS_DOMINANCE = 0.98;

/** The gap vector's dominant world axis, or null when it is oblique. */
export function dominantAxis(gap: Vector3): WorldAxis | null {
  const len = gap.length();
  if (len === 0) return null;
  if (Math.abs(gap.x) >= AXIS_DOMINANCE * len) return 'x';
  if (Math.abs(gap.y) >= AXIS_DOMINANCE * len) return 'y';
  if (Math.abs(gap.z) >= AXIS_DOMINANCE * len) return 'z';
  return null;
}

/**
 * Misclosure of a connector-authored mate at the given poses. `gapWorld`
 * is the follower connector origin's offset from where the mate would put
 * it, keeping only the directions the mate constrains; `tiltDeg` is the
 * follower's orientation error against the driver.
 */
export function mateGap(
  type: MateType,
  driver: BodyState,
  driverConn: ConnectorState,
  follower: BodyState,
  followerConn: ConnectorState,
  options: MateOptions = {},
): { gapWorld: Vector3; tiltDeg: number } {
  const spec = JOINT_SPECS[type];
  if (!spec || spec.contact) {
    return { gapWorld: new Vector3(), tiltDeg: 0 };
  }
  const dOrigin = driverConn.localOrigin.clone().applyQuaternion(driver.quaternion).add(driver.position);
  const dX = driverConn.localXDirection.clone().applyQuaternion(driver.quaternion).normalize();
  const dZ = driverConn.localNormal.clone().applyQuaternion(driver.quaternion).normalize();
  const dY = new Vector3().crossVectors(dZ, dX).normalize();
  const fOrigin = followerConn.localOrigin.clone().applyQuaternion(follower.quaternion).add(follower.position);
  const diff = fOrigin.sub(dOrigin);
  const fixed = defaultParams(options);

  const gapWorld = new Vector3();
  if (!spec.freeSlideXY) {
    gapWorld.addScaledVector(dX, diff.dot(dX) - fixed.x);
    gapWorld.addScaledVector(dY, diff.dot(dY) - fixed.y);
  }
  if (!spec.freeSlideZ) {
    gapWorld.addScaledVector(dZ, diff.dot(dZ) - fixed.slideZ);
  }

  let tiltRad: number;
  if (spec.freeRotZ) {
    // Hinge-like: only the axis must line up, either sign.
    const fZ = followerConn.localNormal.clone().applyQuaternion(follower.quaternion).normalize();
    const cross = new Vector3().crossVectors(fZ, dZ).length();
    tiltRad = Math.atan2(cross, Math.abs(fZ.dot(dZ)));
  } else {
    // Rotation locked (fastened, slider): full orientation against the
    // target at the authored spin.
    const target = computeFastenedTargetPose(
      driver, driverConn, followerConn, { flip: options.flip, rotate: options.rotate },
    );
    tiltRad = quatLog2(target.quaternion.clone().invert().multiply(follower.quaternion)).length();
  }
  return { gapWorld, tiltDeg: tiltRad * 180 / Math.PI };
}

/** The failure record for a connector-authored mate at the given poses. */
export function connectorMateFailure(
  mate: MateRecord,
  driver: BodyState,
  driverConn: ConnectorState,
  follower: BodyState,
  followerConn: ConnectorState,
): MateFailure {
  const { gapWorld, tiltDeg } = mateGap(mate.type, driver, driverConn, follower, followerConn, mate.options ?? {});
  return { mateId: mate.mateId, gap: gapWorld.length(), gapAxis: dominantAxis(gapWorld), tiltDeg };
}

/** The failure record for a tangent (contact) mate: scalar surface gap, no axis. */
export function contactMateFailure(mate: MateRecord, rc: ResolvedContact): MateFailure {
  return { mateId: mate.mateId, gap: Math.abs(contactGap(rc)), gapAxis: null, tiltDeg: 0 };
}
