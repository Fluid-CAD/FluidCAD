import type { TopoDS_Vertex } from "ocjs-fluidcad";
import type { Face } from "../../common/face.js";
import type { Wire } from "../../common/wire.js";
import type { Vector3d } from "../../math/vector3d.js";
import { SpineAnalysis } from "./spine-analysis.js";

/** Kernel transport laws; true Frenet and corrected Frenet are distinct. */
export type SweepTransport =
  | { kind: "binormal"; axis: Vector3d }
  | { kind: "frenet" }
  | { kind: "correctedFrenet" };

/**
 * Placement is independent of transport. Legacy localization/correction is
 * explicitly named until station and alignment resolution replace it. A
 * resolved vertex preserves the drawn offset with contact/correction off.
 */
export type SweepPlacement =
  | { kind: "legacyAutomatic"; withCorrection: boolean }
  | { kind: "atVertex"; vertex: TopoDS_Vertex };

export interface SweepTolerancePolicy {
  /** Legacy lengths are in document/kernel units, not a physical mm budget. */
  readonly policy: "legacyKernelUnits";
  readonly linear3d: number;
  readonly boundary: number;
  readonly angular: number;
  readonly maxSegments: number;
}

/** Preserve existing settings during the refactor; physical tolerances are a later gate. */
export const LEGACY_SWEEP_TOLERANCES: SweepTolerancePolicy = Object.freeze({
  policy: "legacyKernelUnits", linear3d: 1e-4, boundary: 1e-4, angular: 1e-2, maxSegments: 1000,
});

export interface ResolvedSweepSpec {
  readonly spine: SpineAnalysis;
  readonly profileFaces: readonly Face[];
  readonly transport: SweepTransport;
  readonly placement: SweepPlacement;
  readonly tolerances: SweepTolerancePolicy;
}

/**
 * Shared by commit and ghost through SweepOps. This first-stage resolver
 * records existing automatic decisions without changing existing geometry.
 * Explicit options are internal qualification hooks, not public API controls.
 */
export function resolveSweepSpec(
  wire: Wire,
  profileFaces: readonly Face[],
  options: { transport?: SweepTransport; placement?: SweepPlacement } = {},
): ResolvedSweepSpec {
  if (profileFaces.length === 0) {
    throw new Error("Could not extract profile faces from extrudable.");
  }
  const spine = new SpineAnalysis(wire);
  const plane = profileFaces[0].getPlane();
  const placement = options.placement ?? {
    kind: "legacyAutomatic",
    withCorrection: plane.normal.dot(spine.startTangent) >= -0.999,
  };
  // Corner overshoots change the run's vertices. Do not silently discard an
  // explicit station until the corner builder can carry it through its joins.
  if (spine.hasCorners && placement.kind === "atVertex") {
    throw new Error("Explicit sweep stations are currently supported only on smooth paths.");
  }
  return {
    spine, profileFaces: [...profileFaces], placement,
    transport: options.transport ?? spine.trihedron(plane),
    tolerances: LEGACY_SWEEP_TOLERANCES,
  };
}
