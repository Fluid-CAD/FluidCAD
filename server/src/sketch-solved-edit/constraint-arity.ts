// How many targets each constraint kind accepts.

/** Kinds whose statement takes any number of targets (value = minimum) —
 * everything after the first is constrained against it. horizontal and
 * vertical also keep their single-line form. */
export const VARIADIC_CONSTRAINT_KINDS = new Map([
  ['equal', 2], ['parallel', 2], ['horizontal', 1], ['vertical', 1],
]);

/** Shallow arity gate for the routes: variadic kinds take any number of
 * targets (the transform refuses below-minimum with a descriptive 422);
 * every other kind is positional with one to three slots. Shared with the
 * routes so their caps can never drift from this map again. */
export function constraintTargetCountValid(kind: string, count: number): boolean {
  if (count < 1) {
    return false;
  }
  return VARIADIC_CONSTRAINT_KINDS.has(kind) || count <= 3;
}
