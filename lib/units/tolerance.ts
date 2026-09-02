// Absolute kernel tolerances are authored in millimetres; a document that
// runs in inches needs them expressed in inches. A document's numbers ARE
// its unit (plan §2), so every "1e-4 means 0.1 µm" constant in lib/ has to be
// re-expressed in the active unit at USE time — never at module load, where
// no document is active yet.
//
// Every numeric literal that touches geometry falls in one of four classes:
//
// | Class                      | Treatment                 | Examples                                                        |
// |----------------------------|---------------------------|-----------------------------------------------------------------|
// | Absolute length            | `mmTol(x)`                | boolean fuzzy, sewing/approximation tolerances, midpoint         |
// |                            |                           | matches, through-all fallback, solver glue/collapse floors,      |
// |                            |                           | datum plane/axis visual sizes, probe/ray half-lengths            |
// | Squared / cubed length     | `mmTol2(x)` / `mmTol3(x)` | sketch-snap dedup epsilons, boolean "has volume" test            |
// | Angular / dimensionless    | none                      | `Precision.Angular()`, normalised-vector dots, relative          |
// |                            |                           | tolerances (`connectTolerance`'s `extent × 1e-3`), LM ftol,      |
// |                            |                           | `CONFLICT_REL_TOL`, `FREEDOM_TOL`                               |
// | OCCT-internal floor        | none, documented          | `Precision.Confusion()`-based equality, `ShapeFix` /            |
// |                            |                           | `UnifySameDomain` defaults, `BRepClass3d`/intersector `Load`    |
// |                            |                           | tolerances at 1e-7 — the kernel's own floor in whatever unit    |
// |                            |                           | the document uses (sets the mm/cm/m/in/ft envelope)             |
//
// Grep gate: a new `1e-[3-9]` literal in lib/ that is a length must go
// through `mmTol*`; one that is not should carry a `// unit: dimensionless`
// (or angular / OCCT floor) note so the next sweep can skip it.
//
// Feature API defaults (`fillet(1)`, `chamfer(1)`, `text` size 10, helix
// 20/50) are NOT tolerances: they are document-unit defaults and stay numeric
// so the same code means the same thing in every project.

import { MM_PER_UNIT } from './units.js';
import { getActiveUnit } from './registry.js';

/** A length tolerance of `mm` millimetres, in the active unit. */
export function mmTol(mm: number): number {
  return mm / MM_PER_UNIT[getActiveUnit()];
}

/** An area tolerance of `mm2` mm², in the active unit. */
export function mmTol2(mm2: number): number {
  const f = MM_PER_UNIT[getActiveUnit()];
  return mm2 / (f * f);
}

/** A volume tolerance of `mm3` mm³, in the active unit. */
export function mmTol3(mm3: number): number {
  const f = MM_PER_UNIT[getActiveUnit()];
  return mm3 / (f * f * f);
}
