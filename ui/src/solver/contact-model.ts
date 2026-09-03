// Tangent-mate contact model (17-mate-tangent §4–§6).
//
// Tangent mates are RESIDUAL-ONLY: they never appear as spanning-tree
// edges and have no pose()/extract()/dragDelta(). Each mate contributes a
// small set of scalar equality rows (1–2 depending on the surface pair) to
// the joint-space LM, exactly like closure edges. All surface geometry
// arrives pre-classified from the kernel as plain-JS `ContactEntity`
// canonical forms in body-local frame (lib/oc/contact-classify.ts); world
// placement comes from the body pose per evaluation — no OCCT here.
//
// Sign policy (§4.1): contact side is canonical. B-rep face normals point
// out of the material, and physical tangency always happens on the outward
// side of both faces, so plane rows are written on the +n side and the
// axis/center pairs branch only on the convexity pair (external r₁+r₂ vs
// internal |r_concave − r_convex|). Every residual below is branch-free
// and stateless — no flip option, no persisted contact state.
//
// Propagation (§6): each side carries its tangent-continuous chain; per
// evaluation the active PAIR is the supported (entityA, entityB)
// combination with the smallest primary gap among pairs whose approximate
// contact point lies inside both entities' canonical bounds (small
// margin), falling back to the nearest-bounds pair. Along a G1 chain the
// switch changes the residual only at second order, so the FD Jacobian
// stays well-behaved. The row count is fixed per RECORD (max over all
// supported pairs) and short rows are zero-padded, keeping LM dimensions
// stable within a solve.

import { Quaternion, Vector3 } from 'three';
import { ORIENTATION_WEIGHT } from './joint-model.js';
import type { BodyState, ContactEntity, ContactForm, ContactBounds, MateRecord } from './types.js';

const TWO_PI = Math.PI * 2;
/** Bounds slack: contact may sit this far outside the face's canonical extents. */
const LINEAR_MARGIN = 0.5; // mm
/** distLL parallel-configuration fallback threshold on 1 − (u₁·u₂)². */
const PARALLEL_EPS = 1e-12;
/**
 * Active-pair |gap| tie-break tolerance: gaps this close count as equal and
 * the earlier chain pair keeps the slot. A zero-clearance fit (a pin exactly
 * filling a slot) makes the two OPPOSING walls tie in |gap| at EVERY pose —
 * their signed gaps are ±y with only ~1e-15 of float noise between the
 * magnitudes. A strict `<` here lets that noise flip the winner between the
 * residual, FD-probe, and trial evaluates of one LM solve, attaching one
 * wall's gradient to the other wall's sign-flipped residual — the
 * Gauss-Newton step reverses, every trial is rejected, and the mate stalls
 * at the warm-start pose. With the tolerance the pick is deterministic and
 * the emitted row is one wall's smooth signed gap.
 */
const GAP_TIE_EPS = 1e-9;

// ---------------------------------------------------------------------------
// World-frame entities
// ---------------------------------------------------------------------------

type WorldEntity = {
  form: ContactForm;
  point: Vector3;
  dir: Vector3;
  xDir: Vector3 | null;
  yDir: Vector3 | null;
  radius: number;
  halfAngleRad: number;
  convex: boolean;
  bounds?: ContactBounds;
};

function toWorld(e: ContactEntity, position: Vector3, quaternion: Quaternion): WorldEntity {
  const point = new Vector3(...e.point).applyQuaternion(quaternion).add(position);
  const dir = new Vector3(...e.dir).applyQuaternion(quaternion).normalize();
  const xDir = e.xDir
    ? new Vector3(...e.xDir).applyQuaternion(quaternion).normalize()
    : null;
  return {
    form: e.form,
    point,
    dir,
    xDir,
    yDir: xDir ? new Vector3().crossVectors(dir, xDir) : null,
    radius: e.radius ?? 0,
    halfAngleRad: ((e.halfAngleDeg ?? 0) * Math.PI) / 180,
    convex: e.convex,
    bounds: e.bounds,
  };
}

// ---------------------------------------------------------------------------
// Scalar helpers
// ---------------------------------------------------------------------------

/**
 * Robust line–line closest points (17-mate-tangent §4.2): the clamped
 * least-squares solve, NOT the |Δa·(u₁×u₂)| formula — that one is 0/0
 * near parallel axes; this one is continuous through the parallel
 * configuration and smooth wherever dist > 0 (true at every solution).
 */
function lineLineClosest(
  a1: Vector3, u1: Vector3, a2: Vector3, u2: Vector3,
): { dist: number; p1: Vector3; p2: Vector3 } {
  const w = a2.clone().sub(a1);
  const b = u1.dot(u2);
  const d1 = u1.dot(w);
  const d2 = u2.dot(w);
  const denom = 1 - b * b;
  let t1: number;
  let t2: number;
  if (denom > PARALLEL_EPS) {
    t1 = (d1 - b * d2) / denom;
    t2 = (b * d1 - d2) / denom;
  } else {
    t1 = 0;
    t2 = -d2;
  }
  const p1 = a1.clone().addScaledVector(u1, t1);
  const p2 = a2.clone().addScaledVector(u2, t2);
  return { dist: p1.distanceTo(p2), p1, p2 };
}

/**
 * Target center/axis distance from the convexity pair: external contact
 * sums the radii; internal (shaft-in-bore) contact is their difference.
 * Returns null for the un-physical cases (both concave, or a "bore" no
 * larger than its counter-body) — those pairs are unsupported.
 */
function targetDistance(a: WorldEntity, b: WorldEntity): number | null {
  const rA = a.radius;
  const rB = b.radius;
  if (a.convex && b.convex) return rA + rB;
  if (!a.convex && !b.convex) return null;
  const rConcave = a.convex ? rB : rA;
  const rConvex = a.convex ? rA : rB;
  if (rConcave <= rConvex) return null;
  return rConcave - rConvex;
}

/** Axis point at the middle of the entity's axial bounds (or the point itself). */
function axisMidPoint(e: WorldEntity): Vector3 {
  const vMid = e.bounds && e.bounds.vMin !== undefined && e.bounds.vMax !== undefined
    ? (e.bounds.vMin + e.bounds.vMax) / 2
    : 0;
  return e.point.clone().addScaledVector(e.dir, vMid);
}

function excess1D(v: number, min: number | undefined, max: number | undefined, margin: number): number {
  if (min === undefined || max === undefined) return 0;
  if (v < min - margin) return (min - margin) - v;
  if (v > max + margin) return v - (max + margin);
  return 0;
}

/** Angular excess (rad) of θ outside [uMin, uMax] (mod 2π), 0 when inside. */
function angularExcess(theta: number, bounds: ContactBounds, margin: number): number {
  const span = bounds.uMax - bounds.uMin;
  if (span >= TWO_PI - 1e-6) return 0;
  const d = (((theta - bounds.uMin) % TWO_PI) + TWO_PI) % TWO_PI;
  if (d <= span + margin) return 0;
  return Math.min(d - span, TWO_PI - d);
}

/**
 * How far (mm-ish) the point sits outside the entity's canonical bounds;
 * 0 when inside (with margin). This is what keeps an infinite analytic
 * plane from staying "in contact" after the ball has rolled past the
 * physical face edge — the fillet's entity takes over instead.
 */
function boundsExcess(e: WorldEntity, p: Vector3): number {
  if (!e.bounds) return 0;
  const rel = p.clone().sub(e.point);
  switch (e.form) {
    case 'plane': {
      if (!e.xDir || !e.yDir) return 0;
      return excess1D(rel.dot(e.xDir), e.bounds.uMin, e.bounds.uMax, LINEAR_MARGIN)
        + excess1D(rel.dot(e.yDir), e.bounds.vMin, e.bounds.vMax, LINEAR_MARGIN);
    }
    case 'cylinder':
    case 'cone': {
      const v = rel.dot(e.dir);
      let out = excess1D(v, e.bounds.vMin, e.bounds.vMax, LINEAR_MARGIN);
      if (e.xDir && e.yDir) {
        const radial = rel.clone().addScaledVector(e.dir, -v);
        if (radial.lengthSq() > 1e-12) {
          const theta = Math.atan2(radial.dot(e.yDir), radial.dot(e.xDir));
          const rScale = Math.max(e.form === 'cone' ? radial.length() : e.radius, 1);
          out += angularExcess(theta, e.bounds, LINEAR_MARGIN / rScale) * rScale;
        }
      }
      return out;
    }
    case 'line':
      return excess1D(rel.dot(e.dir), e.bounds.uMin, e.bounds.uMax, LINEAR_MARGIN);
    case 'circle': {
      if (!e.xDir || !e.yDir) return 0;
      const inPlane = rel.clone().addScaledVector(e.dir, -rel.dot(e.dir));
      if (inPlane.lengthSq() < 1e-12) return 0;
      const theta = Math.atan2(inPlane.dot(e.yDir), inPlane.dot(e.xDir));
      const rScale = Math.max(e.radius, 1);
      return angularExcess(theta, e.bounds, LINEAR_MARGIN / rScale) * rScale;
    }
    case 'sphere':
      return 0;
  }
}

// ---------------------------------------------------------------------------
// Pair catalog (§4.2, Tier 1 — closed form)
// ---------------------------------------------------------------------------

type PairEval = {
  /** Residual rows (mm for translation-like, ×ORIENTATION_WEIGHT for direction rows). */
  rows: number[];
  /** Primary scalar gap (mm) used by the active-pair selection. */
  gap: number;
  /** Approximate contact location for the bounds gating; null = ungated. */
  contact: Vector3 | null;
};

const sigma = (e: WorldEntity): number => (e.convex ? 1 : -1);

/** plane vs sphere / cylinder / cone / line / circle. `p` is the plane. */
function evalPlanePair(p: WorldEntity, o: WorldEntity): PairEval | null {
  const n = p.dir;
  const q = p.point;
  const W = ORIENTATION_WEIGHT;
  switch (o.form) {
    case 'sphere': {
      const g = o.point.clone().sub(q).dot(n) - sigma(o) * o.radius;
      const contact = o.point.clone().addScaledVector(n, -o.point.clone().sub(q).dot(n));
      return { rows: [g], gap: g, contact };
    }
    case 'cylinder': {
      // Line contact ⇒ axis ∥ plane; two rows.
      const a = axisMidPoint(o);
      const rowDir = o.dir.dot(n) * W;
      const g = a.clone().sub(q).dot(n) - sigma(o) * o.radius;
      // Contact ≈ the axis-mid point dropped onto the surface toward the
      // plane, giving the cylinder side a meaningful angular footpoint.
      const nPerp = n.clone().addScaledVector(o.dir, -n.dot(o.dir));
      const contact = nPerp.lengthSq() > 1e-12
        ? a.clone().addScaledVector(nPerp.normalize(), -sigma(o) * o.radius)
        : a;
      return { rows: [rowDir, g], gap: g, contact };
    }
    case 'cone': {
      // Tangent plane of a cone contains the apex; the axis makes angle
      // (π/2 − α) with the plane ⇒ |u·n| = sin α. The sign of u·n is
      // frozen per evaluation — it flips only across u·n = 0, far from
      // the solution manifold (|u·n| = sin α > 0).
      const un = o.dir.dot(n);
      const s = un >= 0 ? 1 : -1;
      const rowDir = (s * un - Math.sin(o.halfAngleRad)) * W;
      const g = o.point.clone().sub(q).dot(n);
      const contact = o.point.clone().addScaledVector(n, -o.point.clone().sub(q).dot(n));
      return { rows: [rowDir, g], gap: g, contact };
    }
    case 'line': {
      const mid = o.bounds
        ? o.point.clone().addScaledVector(o.dir, (o.bounds.uMin + o.bounds.uMax) / 2)
        : o.point.clone();
      const rowDir = o.dir.dot(n) * W;
      const g = mid.clone().sub(q).dot(n);
      const contact = mid.clone().addScaledVector(n, -mid.clone().sub(q).dot(n));
      return { rows: [rowDir, g], gap: g, contact };
    }
    case 'circle': {
      const nw = Math.min(1, Math.abs(n.dot(o.dir)));
      const g = o.point.clone().sub(q).dot(n) - o.radius * Math.sqrt(Math.max(0, 1 - nw * nw));
      // The circle point nearest the plane: −n orthogonalized into the
      // circle's plane, scaled to the radius.
      const nInPlane = n.clone().addScaledVector(o.dir, -n.dot(o.dir));
      const contact = nInPlane.lengthSq() > 1e-12
        ? o.point.clone().addScaledVector(nInPlane.normalize(), -o.radius)
        : null;
      return { rows: [g], gap: g, contact };
    }
    default:
      return null; // plane–plane: rejected upstream ("use a planar mate")
  }
}

/** Axis/center pairs: cylinder–cylinder / cylinder–sphere / cylinder–line / sphere–sphere. */
function evalAxisPair(a: WorldEntity, b: WorldEntity): PairEval | null {
  const key = pairKey(a.form, b.form);
  if (key === 'sphere|sphere') {
    const dStar = targetDistance(a, b);
    if (dStar === null) return null;
    const g = a.point.distanceTo(b.point) - dStar;
    const contact = a.point.clone().add(b.point).multiplyScalar(0.5);
    return { rows: [g], gap: g, contact };
  }
  if (key === 'cylinder|cylinder') {
    const dStar = targetDistance(a, b);
    if (dStar === null) return null;
    // Single tangent gives POINT contact (axes free to skew) — 1 row,
    // 5 free DOF, matching Fusion. A user wanting line contact (rolling
    // drums) adds a parallel/planar mate; an axis-parallel row here
    // would over-constrain the cam/follower case this mate exists for.
    const { dist, p1, p2 } = lineLineClosest(a.point, a.dir, b.point, b.dir);
    const g = dist - dStar;
    return { rows: [g], gap: g, contact: p1.add(p2).multiplyScalar(0.5) };
  }
  if (key === 'cylinder|sphere') {
    const cyl = a.form === 'cylinder' ? a : b;
    const sph = a.form === 'cylinder' ? b : a;
    const dStar = targetDistance(cyl, sph);
    if (dStar === null) return null;
    const t = sph.point.clone().sub(cyl.point).dot(cyl.dir);
    const foot = cyl.point.clone().addScaledVector(cyl.dir, t);
    const g = sph.point.distanceTo(foot) - dStar;
    return { rows: [g], gap: g, contact: foot.clone().add(sph.point).multiplyScalar(0.5) };
  }
  if (key === 'cylinder|line') {
    const cyl = a.form === 'cylinder' ? a : b;
    const lin = a.form === 'cylinder' ? b : a;
    // d* = r for both a line resting on a shaft and a line touching a
    // bore wall — the axis-to-line distance is the radius either way.
    const { dist, p1, p2 } = lineLineClosest(cyl.point, cyl.dir, lin.point, lin.dir);
    const g = dist - cyl.radius;
    return { rows: [g], gap: g, contact: p1.add(p2).multiplyScalar(0.5) };
  }
  return null;
}

function pairKey(a: ContactForm, b: ContactForm): string {
  return a <= b ? `${a}|${b}` : `${b}|${a}`;
}

/** Tier-1 supported (formA, formB) combinations. */
const SUPPORTED_PAIRS = new Set([
  'plane|sphere', 'cylinder|plane', 'cone|plane', 'line|plane', 'circle|plane',
  'cylinder|cylinder', 'cylinder|sphere', 'cylinder|line', 'sphere|sphere',
]);

export function isSupportedContactPair(a: ContactForm, b: ContactForm): boolean {
  return SUPPORTED_PAIRS.has(pairKey(a, b));
}

/** Rows a supported pair contributes (0 for unsupported). */
export function contactPairRows(a: ContactForm, b: ContactForm): number {
  switch (pairKey(a, b)) {
    case 'cylinder|plane':
    case 'cone|plane':
    case 'line|plane':
      return 2;
    case 'plane|sphere':
    case 'circle|plane':
    case 'cylinder|cylinder':
    case 'cylinder|sphere':
    case 'cylinder|line':
    case 'sphere|sphere':
      return 1;
    default:
      return 0;
  }
}

/**
 * Rows a concrete entity pair contributes: the form-pair count, EXCEPT
 * that the axis/center distance pairs also need a physical convexity
 * combination (both-concave, or a bore no larger than its counter-body,
 * has no target distance and is unsupported).
 */
function entityPairRows(a: ContactEntity, b: ContactEntity): number {
  const rows = contactPairRows(a.form, b.form);
  if (rows === 0) return 0;
  switch (pairKey(a.form, b.form)) {
    case 'cylinder|cylinder':
    case 'cylinder|sphere':
    case 'sphere|sphere': {
      if (a.convex && b.convex) return rows;
      if (!a.convex && !b.convex) return 0;
      const rConcave = a.convex ? (b.radius ?? 0) : (a.radius ?? 0);
      const rConvex = a.convex ? (a.radius ?? 0) : (b.radius ?? 0);
      return rConcave > rConvex ? rows : 0;
    }
    default:
      return rows;
  }
}

function evalPair(a: WorldEntity, b: WorldEntity): PairEval | null {
  if (a.form === 'plane' && b.form !== 'plane') return evalPlanePair(a, b);
  if (b.form === 'plane' && a.form !== 'plane') return evalPlanePair(b, a);
  return evalAxisPair(a, b);
}

// ---------------------------------------------------------------------------
// Record resolution + residual
// ---------------------------------------------------------------------------

export type ResolvedContact = {
  mate: MateRecord;
  a: BodyState;
  b: BodyState;
  /** Body-local candidate entities per side (propagation already sliced). */
  chainA: ContactEntity[];
  chainB: ContactEntity[];
};

/**
 * Resolve a tangent mate's geometry sides against the bodies' published
 * contact states — or the side's own INLINE seed/chain when present (the
 * dialog's provisional record classifies its picks before any expose()
 * exists). Returns null when a side is missing or its seed is an
 * unsupported form — such a mate is unenforceable; the record-build layer
 * reports it loudly, the solver just skips it.
 */
export function resolveContact(
  mate: MateRecord,
  bodyById: Map<string, BodyState>,
): ResolvedContact | null {
  if (mate.type !== 'tangent' || !mate.geometryA || !mate.geometryB) return null;
  const a = bodyById.get(mate.geometryA.instanceId);
  const b = bodyById.get(mate.geometryB.instanceId);
  if (!a || !b) return null;
  const sideState = (
    side: NonNullable<MateRecord['geometryA']>,
    body: BodyState,
  ): { seed: ContactEntity | null; chain: ContactEntity[] } | undefined => {
    if (side.seed !== undefined) {
      return { seed: side.seed, chain: side.chain ?? [] };
    }
    return body.contacts?.find(c => c.exposeName === side.exposeName);
  };
  const stateA = sideState(mate.geometryA, a);
  const stateB = sideState(mate.geometryB, b);
  if (!stateA?.seed || !stateB?.seed) return null;
  const propagate = mate.options?.propagate !== false;
  const chainA = propagate && stateA.chain.length > 0 ? stateA.chain : [stateA.seed];
  const chainB = propagate && stateB.chain.length > 0 ? stateB.chain : [stateB.seed];
  return { mate, a, b, chainA, chainB };
}

/**
 * The record's fixed row count: the max over every supported chain pair,
 * so the active-entity switch can never change LM dimensions mid-solve
 * (§6.2 padding rule). 0 when no pair is supported.
 */
export function contactRowCount(rc: ResolvedContact): number {
  return contactChainsRowCount(rc.chainA, rc.chainB);
}

/**
 * Row count over raw chains — also the mate dialog's pair-solvability
 * check: 0 means no supported (Tier-1 + physical convexity) combination
 * exists between the two picks.
 */
export function contactChainsRowCount(chainA: ContactEntity[], chainB: ContactEntity[]): number {
  let max = 0;
  for (const ea of chainA) {
    for (const eb of chainB) {
      max = Math.max(max, entityPairRows(ea, eb));
    }
  }
  return max;
}

/**
 * Residual rows for the tangent mate at the bodies' CURRENT poses:
 * transform every chain entity to world, pick the active pair (bounds
 * gating + smallest gap), emit its rows zero-padded to the record's fixed
 * dimension. Warm start is the incoming poses — no contact state is
 * stored, continuity is inherent (§5.3).
 */
export function contactResidual(rc: ResolvedContact): number[] {
  const dim = contactRowCount(rc);
  if (dim === 0) return [];
  const best = activeContactPair(rc);
  if (!best) return new Array(dim).fill(0);

  const rows = best.rows.slice();
  while (rows.length < dim) rows.push(0);
  return rows;
}

/**
 * The active pair's primary scalar gap (mm, signed: positive = apart) at
 * the bodies' current poses — the failed-mates report's "how far open"
 * for a tangent mate. 0 when no supported pair exists.
 */
export function contactGap(rc: ResolvedContact): number {
  return activeContactPair(rc)?.gap ?? 0;
}

/**
 * Transform every chain entity to world and pick the active pair: least
 * bounds excess first, then smallest gap.
 */
function activeContactPair(rc: ResolvedContact): PairEval | null {
  const worldA = rc.chainA.map(e => toWorld(e, rc.a.position, rc.a.quaternion));
  const worldB = rc.chainB.map(e => toWorld(e, rc.b.position, rc.b.quaternion));

  let best: { pair: PairEval; excess: number; absGap: number } | null = null;
  for (const ea of worldA) {
    for (const eb of worldB) {
      const ev = evalPair(ea, eb);
      if (!ev) continue;
      const excess = ev.contact
        ? boundsExcess(ea, ev.contact) + boundsExcess(eb, ev.contact)
        : 0;
      const absGap = Math.abs(ev.gap);
      if (
        best === null
        || excess < best.excess - 1e-12
        || (Math.abs(excess - best.excess) <= 1e-12 && absGap < best.absGap - GAP_TIE_EPS)
      ) {
        best = { pair: ev, excess, absGap };
      }
    }
  }
  return best?.pair ?? null;
}

/** ∞-norm satisfaction check for the joints-panel dots / failed-mates report. */
export function contactResidualMaxAbs(rc: ResolvedContact): number {
  let max = 0;
  for (const v of contactResidual(rc)) {
    max = Math.max(max, Math.abs(v));
  }
  return max;
}
