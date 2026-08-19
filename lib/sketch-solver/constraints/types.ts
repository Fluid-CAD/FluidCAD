// Shared contract between the constraint modules and the system/plan
// layers. One module per constraint command; each compiles a spec
// into rows with a residual and analytic partials.

import type { EntityKind, SolverRef } from '../types.js';

/**
 * One scalar residual row. `params` lists the global param indices
 * the row reads (any fixed order, duplicates allowed — the plan
 * builder merges them); `jac` writes ∂residual/∂params[i] into
 * out[i]. Rows are closures compiled once per structural version;
 * branch signs are captured from the guesses at compile time, which
 * is the branch-stability mechanism: a warm re-solve reuses the rows
 * and can never flip.
 */
export type CompiledRow = {
  params: number[];
  eval(p: Float64Array): number;
  jac(p: Float64Array, out: Float64Array): void;
};

/** Param indices of a resolved point. */
export type ResolvedPoint = { ix: number; iy: number };
/** Param indices of a line's endpoints. */
export type ResolvedLine = { sx: number; sy: number; ex: number; ey: number };
/** Param indices of a circle-like entity (circle or arc). */
export type ResolvedCircle = { cx: number; cy: number; r: number };

/**
 * Resolution + guess access handed to constraint modules by the
 * system. Resolvers throw descriptive errors (the dispatcher
 * prefixes them with the constraint id).
 */
export type CompileCtx = {
  /** Current param values — branch signs are locked from these. */
  guess: Float64Array;
  kindOf(id: number): EntityKind;
  point(ref: SolverRef, what: string): ResolvedPoint;
  line(ref: SolverRef, what: string): ResolvedLine;
  circle(ref: SolverRef, what: string): ResolvedCircle;
  /** Does the ref resolve to a point (point entity or a role)? */
  isPoint(ref: SolverRef): boolean;
  /** Entity ref (no role) to a line? */
  isLine(ref: SolverRef): boolean;
  /** Entity ref (no role) to a circle or arc? */
  isCircle(ref: SolverRef): boolean;
  /**
   * Are two resolved points linked by a user point–point coincident
   * statement (directly)? Tangency compiles to the well-conditioned
   * point form at such a junction — the distance form's residual is
   * quadratic in the along-line drift there (rank-deficient at the
   * solution, ~√tol position error).
   */
  arePointsLinked(a: ResolvedPoint, b: ResolvedPoint): boolean;
  /** Is there a user point-on-entity coincident between the resolved
   * point and the entity? */
  isPointOnEntity(p: ResolvedPoint, entityId: number): boolean;
};
