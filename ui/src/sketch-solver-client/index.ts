// UI-side client of the sketch constraint solver (sketch-rewrite P3+).
// P3: the read model — payload join, glyph layout, DOF pill state.
// P4 adds the live drag system on lib/sketch-solver.

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
export { layoutConstraintGlyphs, formatDim, BADGE_LABELS } from './glyphs';
export type { ConstraintGlyph, GlyphColorRole } from './glyphs';
export { computeSketchDofState } from './dof-state';
export type { SketchDofState, FailedConstraint } from './dof-state';
