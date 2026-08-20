// Shared vocabulary of the solved-sketch statement model (sketch-rewrite P5).
//
// One home for the constraint-statement and entity-statement name sets so the
// emission transforms, the insert-geometry placement policy, and the import
// linter can never drift apart. NOTE: the linter's own CONSTRAINT_SYMBOLS also
// carries the legacy geometry qualifiers (outside/enclosed/enclosing) — those
// are import symbols, not constraint statements, and stay out of this set.

/** The 16 solved-sketch constraint statement callees (fluidcad/constraints). */
export const SOLVED_CONSTRAINT_KINDS = new Set<string>([
  'coincident', 'horizontal', 'vertical', 'parallel', 'perpendicular',
  'tangent', 'angle', 'distance', 'radius', 'diameter', 'equal',
  'concentric', 'collinear', 'midpoint', 'symmetric', 'fix',
]);

export type SolvedEntityKind = 'line' | 'arc' | 'circle' | 'point';

/** The solved-sketch entity statement callees (fluidcad/core). */
export const SOLVED_ENTITY_CALLEES = new Set<string>(['line', 'arc', 'circle', 'point']);

/** Binding-name hints per entity kind — `const l1 = line(…)`. */
export const SOLVED_ENTITY_NAME_HINTS: Record<string, string> = {
  line: 'l', arc: 'a', circle: 'c', point: 'p',
};
