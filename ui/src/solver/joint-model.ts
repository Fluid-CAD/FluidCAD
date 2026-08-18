// The generic joint model: one descriptor + a handful of generic ops
// replace the per-mate-type warm-start/fixup/satisfied/readout/drag
// functions that used to live in warm-start.ts, and the hand-written
// residuals in residuals.ts.
//
// Every implemented mate is a lower kinematic pair — a subgroup of
// SE(3) acting between the two connector frames:
//
//   | mate        | subgroup   | free params (driver-connector frame) |
//   |-------------|------------|---------------------------------------|
//   | fastened    | {identity} | —                                     |
//   | revolute    | SO(2)      | rotZ                                  |
//   | slider      | ℝ          | slideZ                                |
//   | cylindrical | SO(2)×ℝ    | rotZ, slideZ                          |
//   | planar      | SE(2)      | x, y, rotZ                            |
//
// Conventions (the generic ops MUST keep matching these exactly):
//
// - Connector frame: `localOrigin`, X = `localXDirection`,
//   Z = `localNormal`, Y = Z × X. World frames via body quat+position.
// - Default is FACE-TO-FACE: follower world Z = −driver world Z.
//   `flip: true` → follower Z = +driver Z.
// - `rotate` (degrees) spins the target X about **driver Z** before
//   re-orthogonalization against target Z.
// - `offset` is in the driver connector's world basis (dX, dY, dZ).
// - rotZ is measured by the log map `signed angle about driver Z`:
//   degrees, 0 = X axes aligned, sign = atan2(cross·dZ, dot).
// - slideZ/x/y are the (follower − driver) connector-origin delta
//   projected on the driver connector's world basis (mm).
//
// Non-free params are FIXED by the mate options:
//   rotZ = options.rotate ?? 0; slideZ = options.offset[2] ?? 0;
//   x, y = options.offset[0, 1] ?? 0.
// The MateBuilder rejects XY offsets for slider/cylindrical/planar and
// limits on anything but revolute (rotZ) / slider (slideZ), so fixing
// the non-free params from options is always consistent.

import { Matrix4, Quaternion, Vector3 } from 'three';
import type { BodyState, ConnectorState, MateRecord } from './types.js';

export type MateType = MateRecord['type'];
export type MateOptions = NonNullable<MateRecord['options']>;

export type JointSpec = {
  freeRotZ?: boolean;     // revolute, cylindrical, planar
  freeSlideZ?: boolean;   // slider, cylindrical
  freeSlideXY?: boolean;  // planar (and pin-slot later)
  dragRotZ?: boolean;     // rotation-by-drag: revolute + cylindrical ONLY
                          // (planar keeps xy-only drag; rotation-by-drag
                          //  for planar is an explicit deferred follow-up
                          //  in PROGRESS.md phase 10 — do not add it here)
  /**
   * Preserve the follower's OBSERVED chirality branch (Z along vs
   * opposed) when the snapshot was satisfied, instead of snapping to
   * the options branch. Revolute ONLY: a Z-parallel bar must not flip
   * 180° when dragged ("drag from either end of a centered bar").
   * Planar and cylindrical historically snap to the options branch
   * every frame ("default warm-starts face-to-face" for planar).
   */
  preserveChirality?: boolean;
  limitParam?: 'rotZ' | 'slideZ';   // what .limits(min,max) applies to
  /** Joint DOF shown in the footer table for a tree edge of this type. */
  freeDof: number;
  /**
   * Residual-only contact mate (tangent): never a spanning-tree edge, no
   * pose()/extract()/dragDelta() — its rows come from contact-model.ts,
   * not from the lower-pair decomposition below. `freeDof` is only the
   * nominal display fallback; real accounting is the rank-based loop DOF.
   */
  contact?: boolean;
};

/**
 * The descriptor table. `parallel` and `pin-slot` deliberately have no
 * entry — they are rejected at parse time (lib/core/mate.ts) and their
 * tree edges are warm-start no-ops until their phases land.
 */
export const JOINT_SPECS: Partial<Record<MateType, JointSpec>> = {
  fastened: { freeDof: 0 },
  revolute: {
    freeRotZ: true, dragRotZ: true, preserveChirality: true,
    limitParam: 'rotZ', freeDof: 1,
  },
  slider: { freeSlideZ: true, limitParam: 'slideZ', freeDof: 1 },
  cylindrical: { freeRotZ: true, freeSlideZ: true, dragRotZ: true, freeDof: 2 },
  planar: { freeRotZ: true, freeSlideXY: true, freeDof: 3 },
  tangent: { freeDof: 5, contact: true },
};

/** The joint's configuration in the driver connector's frame. */
export type JointParams = { rotZ: number; slideZ: number; x: number; y: number };

export function hasFreeParams(spec: JointSpec): boolean {
  return !!(spec.freeRotZ || spec.freeSlideZ || spec.freeSlideXY);
}

/** All four params at their option-fixed / rest values. */
export function defaultParams(options: MateOptions): JointParams {
  return {
    rotZ: options.rotate ?? 0,
    slideZ: options.offset?.[2] ?? 0,
    x: options.offset?.[0] ?? 0,
    y: options.offset?.[1] ?? 0,
  };
}

/**
 * Keep the FREE params from a measured `extracted` set and force the
 * fixed ones back to their option values. This is what makes the
 * extract→pose round trip manifold-snapping: measurement noise (or an
 * LM tilt) on a constrained direction never survives into the re-pose.
 */
export function mergeParams(
  spec: JointSpec,
  extracted: JointParams,
  options: MateOptions,
): JointParams {
  const fixed = defaultParams(options);
  return {
    rotZ: spec.freeRotZ ? extracted.rotZ : fixed.rotZ,
    slideZ: spec.freeSlideZ ? extracted.slideZ : fixed.slideZ,
    x: spec.freeSlideXY ? extracted.x : fixed.x,
    y: spec.freeSlideXY ? extracted.y : fixed.y,
  };
}

// ---------------------------------------------------------------------------
// Reversed-edge (B→A) param space
//
// Mate options are authored in connector A's frame, but a tree edge may
// be traversed from the B side (the anchored part was written second).
// The authored relation F_B = F_A ∘ T(flip, θ, t) inverts to
// F_A = F_B ∘ T⁻¹, and T⁻¹ is expressible in the same option language:
//
//   face-to-face (R is a 180° rotation about an in-plane axis — an
//   involution):  θ′ = θ,   t′ = (−cθ·x − sθ·y,  cθ·y − sθ·x,  z)
//   flip (R = Rz(θ)):        θ′ = −θ,  t′ = (−cθ·x − sθ·y,  sθ·x − cθ·y, −z)
//
// where (x, y, z) is the authored offset and cθ/sθ use the AUTHORED
// angle θ. Crucially, the B-side MEASUREMENTS (extract, dragDelta) are
// already in this reversed space — the log map and the grab-point drag
// arithmetic are side-symmetric up to exactly these transforms — so a
// reversed edge only needs its option-fixed components and limit bounds
// mapped; free params flow through unchanged.
// ---------------------------------------------------------------------------

/**
 * The authored option-fixed components (offset / slide) expressed from
 * the B side, at authored angle `thetaA` (degrees). For joints with a
 * free rotZ and a lateral offset, the B-side fixed components depend on
 * the CURRENT hinge angle — callers must re-evaluate this whenever the
 * angle changes (pose time, every FK evaluate), not bake it once.
 */
function reversedFixed(
  thetaA: number,
  options: MateOptions,
): { x: number; y: number; slideZ: number } {
  const rad = (thetaA * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const [ox, oy, oz] = options.offset ?? [0, 0, 0];
  return {
    x: -(c * ox + s * oy),
    y: options.flip ? s * ox - c * oy : c * oy - s * ox,
    slideZ: options.flip ? -oz : oz,
  };
}

/**
 * Rest params for a REVERSED tree edge, in the B-side space the seed
 * works in: the authored rest angle maps through σ = flip ? −1 : +1 and
 * the offset through the inverse relation above.
 */
export function defaultParamsReversed(options: MateOptions): JointParams {
  const thetaA = options.rotate ?? 0;
  const sigma = options.flip ? -1 : 1;
  const fixed = reversedFixed(thetaA, options);
  return { rotZ: sigma * thetaA, slideZ: fixed.slideZ, x: fixed.x, y: fixed.y };
}

/**
 * REVERSED-edge counterpart of `mergeParams`: free params come from the
 * B-side measurement unchanged; option-fixed components are re-expressed
 * from the B side AT THE CURRENT angle (a reversed revolute with a
 * lateral offset has angle-dependent fixed components). Also serves as
 * the pose-time param mapper — call it again after drag/clamp mutate
 * the free params.
 */
export function mergeParamsReversed(
  spec: JointSpec,
  extracted: JointParams,
  options: MateOptions,
): JointParams {
  const sigma = options.flip ? -1 : 1;
  const rotZB = spec.freeRotZ ? extracted.rotZ : sigma * (options.rotate ?? 0);
  const fixed = reversedFixed(sigma * rotZB, options);
  return {
    rotZ: rotZB,
    slideZ: spec.freeSlideZ ? extracted.slideZ : fixed.slideZ,
    x: spec.freeSlideXY ? extracted.x : fixed.x,
    y: spec.freeSlideXY ? extracted.y : fixed.y,
  };
}

/**
 * `.limits(min, max)` bounds are authored in A-space. The B-side value
 * of the limited param equals the A-side value for face-to-face and its
 * NEGATION under flip — so flipped reversed edges clamp against the
 * negated, swapped bounds.
 */
export function reversedLimits(
  limits: [number, number],
  flip: boolean | undefined,
): [number, number] {
  return flip ? [-limits[1], -limits[0]] : limits;
}

// ---------------------------------------------------------------------------
// World-frame helpers
// ---------------------------------------------------------------------------

type WorldFrame = { origin: Vector3; x: Vector3; y: Vector3; z: Vector3 };

/** The connector's frame in world space (origin + orthonormal basis). */
function connectorFrame(body: BodyState, conn: ConnectorState): WorldFrame {
  const origin = conn.localOrigin.clone()
    .applyQuaternion(body.quaternion).add(body.position);
  const x = conn.localXDirection.clone()
    .applyQuaternion(body.quaternion).normalize();
  const z = conn.localNormal.clone()
    .applyQuaternion(body.quaternion).normalize();
  const y = new Vector3().crossVectors(z, x).normalize();
  return { origin, x, y, z };
}

function connectorOriginWorld(body: BodyState, conn: ConnectorState): Vector3 {
  return conn.localOrigin.clone()
    .applyQuaternion(body.quaternion).add(body.position);
}

function connectorNormalWorld(body: BodyState, conn: ConnectorState): Vector3 {
  return conn.localNormal.clone()
    .applyQuaternion(body.quaternion).normalize();
}

// ---------------------------------------------------------------------------
// pose — the exponential map (params → follower pose)
// ---------------------------------------------------------------------------

/**
 * Follower body pose that realizes the joint configuration `params`
 * relative to the driver connector. Delegates to the one pose kernel
 * (`computeFastenedTargetPose`) with rotate = rotZ and
 * offset = [x, y, slideZ].
 */
export function pose(
  driver: BodyState,
  driverConn: ConnectorState,
  followerConn: ConnectorState,
  options: MateOptions,
  params: JointParams,
): { position: Vector3; quaternion: Quaternion } {
  return computeFastenedTargetPose(driver, driverConn, followerConn, {
    flip: options.flip,
    rotate: params.rotZ,
    offset: [params.x, params.y, params.slideZ],
  });
}

// ---------------------------------------------------------------------------
// extract — the log map (poses → params)
// ---------------------------------------------------------------------------

/**
 * Measure the joint configuration from the two bodies' current poses.
 * All four params are returned regardless of the mate type; callers
 * combine with `mergeParams` to keep only the free ones.
 *
 * rotZ: signed angle (degrees) of the follower connector's X axis
 * relative to the driver connector's X axis, measured about the
 * driver's Z. 0 = X axes aligned. Returns 0 if the follower X is
 * degenerately parallel to the axis. This is the revolute hinge angle /
 * cylindrical spin — the SAME quantity (and sign) the limit clamp and
 * the drag readout pill use.
 *
 * slideZ/x/y: (follower − driver) connector-origin delta projected on
 * the driver connector's world basis.
 */
export function extract(
  driver: BodyState,
  driverConn: ConnectorState,
  follower: BodyState,
  followerConn: ConnectorState,
): JointParams {
  const d = connectorFrame(driver, driverConn);
  const fOrigin = connectorOriginWorld(follower, followerConn);
  const diff = fOrigin.sub(d.origin);

  const fX = followerConn.localXDirection.clone()
    .applyQuaternion(follower.quaternion).normalize();
  const fXInPlane = fX.clone().sub(d.z.clone().multiplyScalar(fX.dot(d.z)));
  let rotZ = 0;
  if (fXInPlane.length() >= 1e-9) {
    fXInPlane.normalize();
    const cos = Math.min(1, Math.max(-1, fXInPlane.dot(d.x)));
    const sin = new Vector3().crossVectors(d.x, fXInPlane).dot(d.z);
    rotZ = (Math.atan2(sin, cos) * 180) / Math.PI;
  }

  return {
    rotZ,
    slideZ: diff.dot(d.z),
    x: diff.dot(d.x),
    y: diff.dot(d.y),
  };
}

// ---------------------------------------------------------------------------
// residual — the constrained components of the same decomposition
// ---------------------------------------------------------------------------

// Length-scale factor that makes orientation residuals cost-comparable
// to position residuals. Position residuals are in mm; orientation
// residuals are dimensionless (`sin(θ)` for axis projections, axis-angle
// magnitudes for full 3D). Without scaling, a 1° tilt costs ~3e-4 while
// a 1 mm position error costs 1 — so LM tolerates visibly-tilted
// solutions to gain tiny position improvements. Multiplying by a
// length scale (~ typical link size in mm) makes a 1° tilt cost
// `(0.017 × 25)² ≈ 0.18`, comparable to a 0.4 mm error.
//
// Higher values keep orientation tighter but make LM "stiffer" — closed
// loops can struggle to close when orientation residuals dominate the
// cost. 25 is a compromise that keeps tilt below ~1° while letting LM
// reduce closure gaps to sub-millimeter.
export const ORIENTATION_WEIGHT = 25;

/**
 * Residual vector for the mate: zero iff the mate is satisfied, one
 * entry per CONSTRAINED component of the joint decomposition. Free
 * params contribute nothing. Dimensions:
 *
 *   fastened 6 (3 pos + 3 axis-angle), revolute 5 (3 pos + 2
 *   axis-parallel), slider 5 (2 perp + 3 axis-angle), cylindrical 4
 *   (2 perp + 2 axis-parallel), planar 3 (1 along-Z + 2 axis-parallel).
 *
 * Axis-parallel components accept BOTH Z signs (|fZ·dZ| = 1 either
 * way) — chirality is set by the warm-start via `options.flip`, and LM
 * cannot flip it because the gradient pulls toward the nearest minimum.
 * Rotation-locked types (fastened, slider) compare full orientations
 * via the axis-angle of `target⁻¹ · follower`, so they DO pin
 * chirality (through the flip baked into the target).
 *
 * Orientation rows are scaled by ORIENTATION_WEIGHT; translation rows
 * are raw mm in the driver connector's basis.
 */
export function residual(
  type: MateType,
  driver: BodyState,
  driverConn: ConnectorState,
  follower: BodyState,
  followerConn: ConnectorState,
  options: MateOptions = {},
): number[] {
  const spec = JOINT_SPECS[type];
  // Contact mates (tangent) have no connector-frame decomposition — their
  // rows come from contact-model.ts (resolveContact + contactResidual).
  if (!spec || spec.contact) return [];

  // Fastened compares full body poses against the target pose — the
  // historical formulation (body-origin delta rather than connector
  // delta); kept verbatim so LM dynamics don't shift.
  if (!hasFreeParams(spec)) {
    const target = computeFastenedTargetPose(driver, driverConn, followerConn, options);
    const ang = quatLog2(
      target.quaternion.clone().invert().multiply(follower.quaternion),
    );
    return [
      follower.position.x - target.position.x,
      follower.position.y - target.position.y,
      follower.position.z - target.position.z,
      ang.x * ORIENTATION_WEIGHT,
      ang.y * ORIENTATION_WEIGHT,
      ang.z * ORIENTATION_WEIGHT,
    ];
  }

  const d = connectorFrame(driver, driverConn);
  const fOrigin = connectorOriginWorld(follower, followerConn);
  const diff = fOrigin.sub(d.origin);
  const fixed = defaultParams(options);
  const rows: number[] = [];

  // Translation rows: each constrained direction, minus its fixed offset.
  if (!spec.freeSlideXY) {
    rows.push(diff.dot(d.x) - fixed.x);
    rows.push(diff.dot(d.y) - fixed.y);
  }
  if (!spec.freeSlideZ) {
    rows.push(diff.dot(d.z) - fixed.slideZ);
  }

  // Orientation rows.
  if (spec.freeRotZ) {
    // Axis parallelism: perpendicular components of follower Z in the
    // driver basis. Zero for both parallel and anti-parallel Z.
    const fZ = connectorNormalWorld(follower, followerConn);
    rows.push(fZ.dot(d.x) * ORIENTATION_WEIGHT);
    rows.push(fZ.dot(d.y) * ORIENTATION_WEIGHT);
  } else {
    // Rotation fully locked (slider): compare against the target
    // orientation at the fixed spin. Orientation is independent of the
    // slide, so the offset is omitted from the target.
    const target = computeFastenedTargetPose(
      driver, driverConn, followerConn,
      { flip: options.flip, rotate: options.rotate },
    );
    const ang = quatLog2(
      target.quaternion.clone().invert().multiply(follower.quaternion),
    );
    rows.push(ang.x * ORIENTATION_WEIGHT);
    rows.push(ang.y * ORIENTATION_WEIGHT);
    rows.push(ang.z * ORIENTATION_WEIGHT);
  }

  return rows;
}

// ---------------------------------------------------------------------------
// isSatisfied
// ---------------------------------------------------------------------------

/**
 * One EPS for every mate type (replaces the four legacy per-type EPS
 * constants, which were all 1e-4). Translation rows compare in mm;
 * orientation compares via the legacy cosine measure
 * `|1 − |fZ·dZ|| < EPS` (⇔ tilt ≲ 0.014 rad ≈ 0.8°) so the
 * reseed-vs-preserve decision keeps its historical looseness — a
 * strict small-angle gate here would make post-LM loop poses read as
 * "fresh assembly" and wipe accumulated joint state on the next frame.
 */
export const JOINT_EPS = 1e-4;

/**
 * True iff the mate is satisfied at the given poses, within JOINT_EPS.
 * Used by the warm-start's snapshot-based reseed-vs-preserve decision.
 */
export function isSatisfied(
  type: MateType,
  driver: BodyState,
  driverConn: ConnectorState,
  follower: BodyState,
  followerConn: ConnectorState,
  options: MateOptions = {},
): boolean {
  const spec = JOINT_SPECS[type];
  if (!spec || spec.contact) return false;

  const d = connectorFrame(driver, driverConn);
  const fOrigin = connectorOriginWorld(follower, followerConn);
  const diff = fOrigin.sub(d.origin);
  const fixed = defaultParams(options);

  if (!spec.freeSlideXY) {
    if (Math.abs(diff.dot(d.x) - fixed.x) > JOINT_EPS) return false;
    if (Math.abs(diff.dot(d.y) - fixed.y) > JOINT_EPS) return false;
  }
  if (!spec.freeSlideZ) {
    if (Math.abs(diff.dot(d.z) - fixed.slideZ) > JOINT_EPS) return false;
  }

  if (spec.freeRotZ) {
    const fZ = connectorNormalWorld(follower, followerConn);
    return Math.abs(Math.abs(fZ.dot(d.z)) - 1) < JOINT_EPS;
  }
  if (spec.freeSlideZ || spec.freeSlideXY) {
    // Rotation fully locked but position partly free (slider): the
    // historical contract checks POSITION ONLY — a carriage that
    // arrives on-axis but arbitrarily oriented (fresh insert) keeps its
    // measured slide, and the warm-start pose snaps the orientation.
    // Adding an orientation gate here would reseed the slide to the
    // rest value instead ("successive drags accumulate the slide
    // value" encodes this).
    return true;
  }
  // Fastened: nothing is free, so "satisfied" isn't consulted by the
  // warm-start (it always re-poses). Answer via the residual anyway.
  const r = residual(type, driver, driverConn, follower, followerConn, options);
  return r.every(v => Math.abs(v) < JOINT_EPS * ORIENTATION_WEIGHT);
}

/**
 * Which branch of the axis-parallel manifold the follower sits on:
 * `true` when follower Z points ALONG driver Z (the `flip: true`
 * branch), `false` for face-to-face. The freeRotZ residual accepts
 * both signs, so a follower can legitimately live on either branch
 * (via its initial pose or an external rotation); the warm-start
 * preserves the OBSERVED branch when the snapshot was satisfied so a
 * solve never flips a body 180° ("drag from either end of a centered
 * bar" encodes this for revolute).
 */
export function observedFlip(
  driver: BodyState,
  driverConn: ConnectorState,
  follower: BodyState,
  followerConn: ConnectorState,
): boolean {
  const dZ = connectorNormalWorld(driver, driverConn);
  const fZ = connectorNormalWorld(follower, followerConn);
  return fZ.dot(dZ) > 0;
}

// ---------------------------------------------------------------------------
// dragDelta — generic drag → free-param deltas
// ---------------------------------------------------------------------------

/** Drag inputs consumed by the mate-aware warm-start paths. */
export type TreeDragInfo = {
  draggedInstanceId?: string;
  /** Raw cursor world position on the drag plane. */
  draggedCursorWorld?: Vector3;
  /** Grab point in body-local frame. */
  draggedGrabLocal?: Vector3;
};

const ZERO_DELTA: JointParams = { rotZ: 0, slideZ: 0, x: 0, y: 0 };

/**
 * Free-param deltas that bring the dragged body's GRAB POINT to the
 * cursor, expressed in the driver connector's frame:
 *
 *   1. grabWorld = grabLocal · draggedBody.quat + draggedBody.pos
 *   2. delta = cursor − grabWorld
 *   3. freeSlideZ  → dSlideZ = delta·dZ
 *   4. freeSlideXY → dX/dY = delta·dX, delta·dY
 *   5. dragRotZ    → translate the grab by the deltas from 3–4, then
 *      in-plane rotation atan2(cross·dZ, dot) from (grab − pivot) to
 *      (cursor − pivot) about driver Z. The pivot's position ALONG the
 *      axis is irrelevant (both vectors are projected onto the plane
 *      ⊥ dZ), so the driver connector origin serves as the pivot.
 *
 * Using the grab point — never the body origin — as the "from" of the
 * rotation arc is what keeps the sign correct on either side of the
 * pivot (tests encode this).
 *
 * The drag applies when the dragged body is the follower itself or any
 * body fastened-connected to it: the rigid cluster moves as one.
 * Grounded followers never move.
 */
export function dragDelta(
  spec: JointSpec,
  driver: BodyState,
  driverConn: ConnectorState,
  follower: BodyState,
  allMates: MateRecord[],
  drag: TreeDragInfo,
  bodyById: Map<string, BodyState>,
  clusters: FastenedClusterCache | undefined,
): JointParams {
  if (!hasFreeParams(spec)) return { ...ZERO_DELTA };
  const { draggedInstanceId, draggedCursorWorld, draggedGrabLocal } = drag;
  if (!draggedCursorWorld || !draggedGrabLocal || !draggedInstanceId) {
    return { ...ZERO_DELTA };
  }
  if (follower.grounded) return { ...ZERO_DELTA };
  const cluster = clusters?.get(follower.instanceId)
    ?? findFastenedCluster(follower.instanceId, allMates);
  if (!cluster.has(draggedInstanceId)) return { ...ZERO_DELTA };
  const draggedBody = bodyById.get(draggedInstanceId);
  if (!draggedBody) return { ...ZERO_DELTA };

  const grabWorld = draggedGrabLocal.clone()
    .applyQuaternion(draggedBody.quaternion)
    .add(draggedBody.position);
  const d = connectorFrame(driver, driverConn);
  const delta = draggedCursorWorld.clone().sub(grabWorld);

  const out: JointParams = { ...ZERO_DELTA };
  if (spec.freeSlideZ) out.slideZ = delta.dot(d.z);
  if (spec.freeSlideXY) {
    out.x = delta.dot(d.x);
    out.y = delta.dot(d.y);
  }
  if (spec.dragRotZ) {
    const grabAfterSlide = grabWorld.clone()
      .addScaledVector(d.z, out.slideZ)
      .addScaledVector(d.x, out.x)
      .addScaledVector(d.y, out.y);
    const fromVec = grabAfterSlide.sub(d.origin);
    const toVec = draggedCursorWorld.clone().sub(d.origin);
    const fromInPlane = fromVec.clone()
      .sub(d.z.clone().multiplyScalar(fromVec.dot(d.z)));
    const toInPlane = toVec.clone()
      .sub(d.z.clone().multiplyScalar(toVec.dot(d.z)));
    if (fromInPlane.length() >= 1e-9 && toInPlane.length() >= 1e-9) {
      fromInPlane.normalize();
      toInPlane.normalize();
      const cos = Math.min(1, Math.max(-1, fromInPlane.dot(toInPlane)));
      const sin = new Vector3().crossVectors(fromInPlane, toInPlane).dot(d.z);
      out.rotZ = (Math.atan2(sin, cos) * 180) / Math.PI;
    }
  }
  return out;
}

/**
 * Number of rows `residual()` returns for the mate type (0 for types
 * without a joint model): constrained translation directions plus
 * either 2 axis-parallel rows (freeRotZ) or 3 axis-angle rows.
 */
export function residualDimension(type: MateType): number {
  const spec = JOINT_SPECS[type];
  // Contact mates: per-RECORD row counts (contactRowCount) — the pair of
  // surface forms, not the type, fixes the dimension.
  if (!spec || spec.contact) return 0;
  return (spec.freeSlideXY ? 0 : 2)
    + (spec.freeSlideZ ? 0 : 1)
    + (spec.freeRotZ ? 2 : 3);
}

/**
 * Drag residual (3 components): grab world position minus cursor world
 * position. Zero iff the body's grab point sits at the cursor target.
 *
 * Used in the LM cost when the dragged body is in a relaxed component:
 * for pure chains it is the ONLY residual (weight-free inverse
 * kinematics); for closed loops it enters with a small weight so the
 * closure dominates when the cursor is unreachable.
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

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** Clamp a scalar DOF value to an optional [min, max] motion-limit range. */
export function clampToLimits(value: number, limits?: [number, number]): number {
  if (!limits) return value;
  return Math.min(limits[1], Math.max(limits[0], value));
}

/**
 * Shift `angle` (degrees) by whole turns onto the 360° branch nearest
 * `ref`, so a per-frame sequence of angle measurements stays continuous
 * across the ±180° branch cut. Used by revolute limits: the cut would
 * otherwise fall right on a `limits(.., 180)` bound and flip the clamp.
 */
export function unwrapAngleNear(angle: number, ref: number): number {
  return angle + 360 * Math.round((ref - angle) / 360);
}

/**
 * Enforce `.limits(min, max)` on the joint's limited param (mutates
 * `params`). For rotZ the angle is first unwrapped onto the branch
 * nearest the snapshot angle, so a hinge pushed past 180° pins at 180°
 * instead of flipping to the other bound (the atan2 branch-cut bug).
 * Runs for both freshly-seeded rest values and dragged values, so an
 * out-of-range rest angle is pulled into range too.
 */
export function clampParamsToLimits(
  spec: JointSpec,
  params: JointParams,
  limits: [number, number] | undefined,
  snapshotParams: JointParams | null,
): void {
  if (!limits || !spec.limitParam) return;
  if (spec.limitParam === 'rotZ') {
    let angle = params.rotZ;
    if (snapshotParams) angle = unwrapAngleNear(angle, snapshotParams.rotZ);
    params.rotZ = clampToLimits(angle, limits);
  } else {
    params.slideZ = clampToLimits(params.slideZ, limits);
  }
}

// ---------------------------------------------------------------------------
// Fastened target-pose computation (the analytical kernel reused by all
// mate types as their face-to-face/anti-parallel base pose).
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
// Fastened clusters
// ---------------------------------------------------------------------------

/**
 * Set of instance ids that are fastened-connected to `rootId` (transitively).
 * A fastened cluster moves as a single rigid body, so a drag of any cluster
 * member is equivalent to dragging the cluster as a whole — relevant for
 * the non-fastened tree-edge warm-starts where the dragged body need not
 * be the immediate follower.
 */
export function findFastenedCluster(rootId: string, mates: MateRecord[]): Set<string> {
  const cluster = new Set<string>([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const m of mates) {
      if (m.type !== 'fastened' || !m.connectorA || !m.connectorB) continue;
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
    if (m.type !== 'fastened' || !m.connectorA || !m.connectorB) continue;
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
// Quaternion log
// ---------------------------------------------------------------------------

/**
 * 2 · log(q) — the axis-angle vector of unit quaternion `q`. Zero iff
 * q is the identity rotation (q.w = ±1, q.xyz = 0). Used as a 3D
 * orientation residual that's smooth through the identity.
 *
 * For unit q with `q.w ≈ 1` (small angle): ≈ 2·(q.x, q.y, q.z).
 * Generally: angle = 2·atan2(|q.xyz|, q.w), axis = q.xyz / |q.xyz|,
 * result = angle · axis = 2·q.xyz·atan2(|q.xyz|, q.w) / |q.xyz|.
 */
export function quatLog2(q: Quaternion): Vector3 {
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
