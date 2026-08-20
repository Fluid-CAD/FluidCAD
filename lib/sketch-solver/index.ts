// lib/sketch-solver/ — the kernel-independent 2D constraint solver:
// entities/constraints in, solved params + diagnostics out. Pure TS;
// imports only lib/solver-core/ (purity-guarded). Consumed by the
// kernel's solved-sketch features (P2) and the browser drag client
// (P4). Nothing outside this directory may depend on LM internals —
// the engine-shaped interface here is the swap seam.

export { SketchSystem } from './system.js';
export type { CompiledSystem, EntityOptions } from './system.js';
export { solve } from './solve.js';
export { diagnose } from './diagnose.js';
export {
  center, end, entityRef, start,
  DATUM_ENTITY_IDS, ORIGIN_ENTITY, X_AXIS_ENTITY, Y_AXIS_ENTITY, datumNameOf,
} from './types.js';
export type {
  DatumName,
  ComponentDiagnostics,
  ComponentSolveResult,
  ConstraintKind,
  ConstraintRecord,
  ConstraintSpec,
  DiagnoseOptions,
  DragPoint,
  DragSpec,
  EntityKind,
  EntityRecord,
  PointRole,
  SketchDiagnostics,
  SketchSolverSystem,
  SolveOptions,
  SolveOutcome,
  SolveResult,
  SolverRef,
} from './types.js';
