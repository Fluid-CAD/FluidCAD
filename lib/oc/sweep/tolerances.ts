import { getActiveUnit } from "../../units/registry.js";
import { mmTol } from "../../units/tolerance.js";
import type { LengthUnit } from "../../units/units.js";

export interface SweepTolerancePolicy {
  readonly policy: "physical";
  readonly unit: LengthUnit;
  /** Lengths expressed in the active document unit. */
  readonly linear3d: number;
  readonly boundary: number;
  /** Radians; independent of document units. */
  readonly angular: number;
  readonly maxSegments: number;
}

/** Resolve at build time, never at module load when no document is active. */
export function resolveSweepTolerances(): SweepTolerancePolicy {
  return Object.freeze({
    policy: "physical", unit: getActiveUnit(),
    linear3d: mmTol(1e-4), boundary: mmTol(1e-4),
    angular: 1e-2, maxSegments: 1000,
  });
}
