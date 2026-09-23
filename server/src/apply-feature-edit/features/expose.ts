// expose(): option types and the cross-part exposure reference contract.

import type { ApplyFeatureEditSpec } from '../spec.ts';

/**
 * Expose create payload. `name` is the identifier the statement registers
 * (same pattern the kernel enforces); `part` is the `part(...)` call site
 * whose callback body receives the statement.
 */
export type ExposeEditOptions = {
  name: string;
  /** The `part(...)` call site whose callback body receives the statement. */
  part?: { line: number; column: number };
};

/**
 * One consumer-side cross-part reference: geometry another part publishes
 * (or will publish) with `expose()`, rendered as `<ident>.features.<exposeName>`
 * inside the consumer's own statement — a sketch on the donor's face
 * (`sketchForeign`) or a projection of the donor's faces and edges
 * (`project.foreign`). Exactly one addressing mode:
 *
 *   - `donor` (same-file): the donor `part(...)` call site — the transform
 *     resolves the module-level `const` its definition is bound to and
 *     renders that identifier.
 *   - `ident` + `importFrom` (cross-file): the donor's export identifier and
 *     the module specifier to import it from.
 *
 * `create` (same-file only) is a full `'expose'` spec applied FIRST in the
 * same transform — find-or-create stays atomic, and every call site the
 * consumer statement still needs is relocated across the intermediate edit
 * before it lands. Cross-file creation rides its own dispatch to the donor
 * file instead.
 */
export type ForeignExposureRef = {
  exposeName: string;
  /** Same-file donor: its `part(...)` call site. */
  donor?: { line: number; column: number };
  /** Cross-file donor: the export identifier the reference renders. */
  ident?: string;
  /** Cross-file donor: module specifier `ident` is imported from. */
  importFrom?: string;
  /** Same-file find-or-create: the `'expose'` spec applied first, atomically. */
  create?: ApplyFeatureEditSpec;
};
