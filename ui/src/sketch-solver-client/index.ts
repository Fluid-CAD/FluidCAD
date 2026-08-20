// UI-side client of the sketch constraint solver (sketch-rewrite P3+).
// P3: the read model — payload join, glyph layout, DOF pill state.
// P4: the live drag system on lib/sketch-solver — snapshot rebuild,
// pure hit testing, and drag-preview tessellation.

export {
  buildSolvedSketchModel,
  isSolvedSketch,
  specEntityIds,
} from './model';
export type {
  ConstraintStatus,
  SolvedConstraintView,
  SolvedEntityView,
  SolvedEntityKind,
  SolvedSketchModel,
} from './model';
export {
  layoutConstraintGlyphs, distanceSpecEndpoints, distanceSpecExtensions, formatDim, BADGE_LABELS,
} from './glyphs';
export type { ConstraintGlyph, GlyphColorRole } from './glyphs';
export { computeSketchDofState } from './dof-state';
export type { SketchDofState, FailedConstraint } from './dof-state';
export { LiveSolvedSystem } from './live-system';
export type { LiveEntityGeometry } from './live-system';
export { solvedHitTest, datumHitTest, refFor } from './hit-test';
export type { SolvedHit, SolvedVertexHit, SolvedEdgeHit, SolvedDatumHit, SketchDatumName } from './hit-test';
export { tessellateSolvedEntity, arcSweep } from './tessellate';
export { buildPositionWriteBack } from './write-back';
export { updateDragTargets } from './drag-targets';
export type { SolvedDragMode, SolvedDragTarget } from './drag-targets';
