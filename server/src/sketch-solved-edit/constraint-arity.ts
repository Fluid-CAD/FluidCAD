// How many targets each constraint kind accepts.

/** Kinds whose statement takes any number of targets (value = minimum) —
 * everything after the first is constrained against it. horizontal and
 * vertical also keep their single-line form. */
export const VARIADIC_CONSTRAINT_KINDS = new Map([
  ['equal', 2], ['parallel', 2], ['horizontal', 1], ['vertical', 1],
]);

/**
 * Kinds whose statement pairs a list of offset entities with a list of
 * sources — `offsetFrom([o1, o2], [s1, s2], d)`, or the bare pair
 * `offsetFrom(o, s, d)`. On the wire the targets ride flat: the N offset
 * entities first, then their N sources, so the count is even.
 */
export const PAIRED_CONSTRAINT_KINDS = new Set(['offsetFrom']);

/** Shallow arity gate for the routes: variadic kinds take any number of
 * targets (the transform refuses below-minimum with a descriptive 422);
 * every other kind is positional with one to three slots. Shared with the
 * routes so their caps can never drift from this map again. */
export function constraintTargetCountValid(kind: string, count: number): boolean {
  if (count < 1) {
    return false;
  }
  if (PAIRED_CONSTRAINT_KINDS.has(kind)) {
    return count >= 2 && count % 2 === 0;
  }
  return VARIADIC_CONSTRAINT_KINDS.has(kind) || count <= 3;
}
