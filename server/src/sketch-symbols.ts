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

export type SolvedEntityKind = 'line' | 'arc' | 'circle' | 'point' | 'ellipse';

/** The solved-sketch entity statement callees (fluidcad/core). The ellipse
 * is an entity like the circle: its `center` role is its one point
 * accessor, and the bare name takes horizontal/vertical/concentric/tangent;
 * its radii stay literals. */
export const SOLVED_ENTITY_CALLEES = new Set<string>(['line', 'arc', 'circle', 'point', 'ellipse']);

/** What the emission rail may write as geometry: the entity statements. */
export type SolvedGeometryKind = SolvedEntityKind;

export const SOLVED_GEOMETRY_CALLEES = new Set<string>([...SOLVED_ENTITY_CALLEES]);

/** Binding-name hints per entity kind — `const l1 = line(…)`,
 * `const el1 = ellipse(…)`. Reference producers (P6) hoist too:
 * `const prj1 = project(…)`, and so do 2D copy statements whose duplicates
 * are constraint targets (`const cp1 = copy(…)`) and the anchor-point
 * statements (P8): `const t1 = text(…)`, `const bz1 = bezier(…)`. */
export const SOLVED_ENTITY_NAME_HINTS: Record<string, string> = {
  line: 'l', arc: 'a', circle: 'c', point: 'p', project: 'prj', intersect: 'sec',
  copy: 'cp', mirror: 'm', ellipse: 'el', text: 't', bezier: 'bz',
};

/**
 * Edge-consuming derived-op callees — the TAIL region of a solved sketch
 * body (geometry → constraints → derived ops). They resolve their targets
 * over already-built edges, so they must run after every geometry statement;
 * placing them after the constraints keeps pause-before edits (offset,
 * fillet) looking at the fully SOLVED sketch instead of raw guesses.
 * `project`/`intersect` are reference producers, not edge consumers — they
 * stay in the geometry region.
 */
export const DERIVED_OP_CALLEES = new Set<string>([
  'offset', 'fillet', 'mirror', 'copy', 'rotate', 'text',
]);

/**
 * The derived-op statements a constraint target may address as a whole —
 * the 2D copy and the 2D mirror. A copy() duplicate is a solver entity
 * reachable through the slot-indexed accessor (`cp.instance(k)` — the
 * original occupies its own slot, duplicates fill the others, `skip` leaves
 * holes); a mirror() image through the source-keyed accessor
 * (`m.instance(l)`, `m.instance(cp.instance(k))`). offset/fillet/rotate stay
 * untargetable. `text` (and the geometry-region `bezier`) are targetable
 * through their anchor POINTS only (P8): `t.anchor()`, `bz.point(i)`.
 */
export const COPY_CALLEES = new Set<string>(['copy']);
export const MIRROR_CALLEES = new Set<string>(['mirror']);

/**
 * Anchor-point statements (P8): not solver entities themselves, but their
 * position params — the text anchor, a bezier's literal control points —
 * are free solver points a constraint target may address via the
 * featureType-derived accessor.
 */
export const ANCHOR_CALLEES = new Set<string>(['text', 'bezier']);
