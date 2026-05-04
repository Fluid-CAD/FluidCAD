// Revolute mate (1 DOF rotate): two connectors share an origin; their Z
// axes are parallel; X/Y free to rotate around the shared Z.
//
// Two compilation paths share this file:
//
//   1. **Default (tree / 3D-loop path).** The compiler returns `[]`.
//      Geometry is enforced JS-side: `warm-start.ts:seedRevoluteEdge`
//      computes the follower's pose analytically, locks both position
//      and orientation, and `loop-relaxation.ts` runs Levenberg-Marquardt
//      for closures. Slvs sees no constraints for this mate. See
//      `mate-implementation-pattern.md` §2 for the full rationale —
//      slvs's POINT_IN_2D entities silently drop the connector's local
//      Z, which makes POINTS_COINCIDENT unfaithful for connectors that
//      live above/below the body's xy plane (the common case: a
//      connector on a top face).
//
//   2. **slvs-solvable loop path.** When the mate is listed in
//      `ctx.slvsEmitMates` (set by `slvs-loop.ts:classifySlvsSolvable`),
//      the compiler emits real slvs constraints. The slvs-solvable
//      criterion guarantees every loop body's mate connector has a
//      world normal of ±world Z, which means the POINT_IN_2D Z-drop
//      cancels between the two sides of a POINTS_COINCIDENT constraint —
//      slvs's projected equation matches reality. Slvs then solves the
//      closure (and any drag, via the dragged[] pin) natively.
//
// Constraints emitted on the slvs-solvable path:
//   - POINTS_COINCIDENT(a.point, b.point) in FREE_IN_3D — coincides the
//     two connector points in world space (3 equations).
//
// We deliberately do NOT add a PARALLEL constraint between the two body
// normals here. The slvs-solvable criterion (slvs-loop.ts) already
// guarantees both normals are ≈ world Z, so PARALLEL would be a
// rank-deficient constraint — slvs's solver flags the resulting system
// as INCONSISTENT instead of working around the redundancy. Without
// PARALLEL the mate is geometrically a spherical joint, but starting
// from a planar warm-start and (during drag) anchored by slvs's
// dragged[] pin, the iterative solve stays near planar and the
// closure manifold the user expects is the one slvs converges to.
//
// .rotate(deg) is consumed by the JS-side warm-start as a seed angle;
// revolute is 1-DOF so there's no constraint to express the rotation —
// it's a starting configuration along the free DOF.

import type { CompileCtx } from '../mate-compiler.js';
import { lookupConnector } from '../mate-compiler.js';
import type { MateRecord } from '../types.js';
import { GROUP_ACTIVE } from '../system-builder.js';

export function compileRevolute(ctx: CompileCtx, mate: MateRecord): number[] {
  if (!ctx.slvsEmitMates.has(mate.mateId)) return [];

  const a = lookupConnector(ctx, mate.connectorA.instanceId, mate.connectorA.connectorId);
  const b = lookupConnector(ctx, mate.connectorB.instanceId, mate.connectorB.connectorId);

  const C = ctx.api.C;
  const FREE = ctx.api.FREE_IN_3D;

  const cCoincident = ctx.sys.addConstraint(
    ctx.newH(), GROUP_ACTIVE,
    C.POINTS_COINCIDENT, FREE,
    0,
    a.connector.point, b.connector.point,
    0, 0, 0, 0,
  );

  return [cCoincident];
}
