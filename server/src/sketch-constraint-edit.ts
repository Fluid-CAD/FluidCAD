// Constraint-statement emission for solved sketches (sketch-rewrite P4).
//
// The toolbar's "add constraint" rides the generic apply-feature-edit round
// trip as a self-contained sub-spec (the paramEdit pattern —
// both editor hosts already speak the transport). Since P5 the actual
// transform lives in sketch-solved-edit.ts (which also emits geometry);
// a constraint-only edit is an emission with no geometry.

import {
  applySolvedEmission,
  type SolvedEmissionRole,
} from './sketch-solved-edit.ts';
import type { SolvedEntityKind } from './sketch-symbols.ts';

export type SketchConstraintTarget = {
  /** 1-indexed line of the entity statement… */
  line?: number;
  /** Loop-instance targeting: present when the statement at `line` executed
   * more than once in the last render (a user `for` loop) — the 0-based
   * execution index of the picked instance. Composes only with `line`. */
  occurrence?: number;
  /** …or an implicit sketch datum, rendered as its accessor call
   * (origin()/xAxis()/yAxis()) — datums have no source statement. */
  datum?: 'origin' | 'x-axis' | 'y-axis';
  /** Point accessor rendered as `.role()`; absent = the entity itself. */
  role?: SolvedEmissionRole;
  /** The entity command the statement must call — a mismatch means the
   * source changed under the picks and refuses the edit. References (P6)
   * name their producer callee; copy-instance targets name theirs. */
  featureType?: SolvedEntityKind | 'project' | 'intersect' | 'copy';
  /** Fixed reference targets (P6): the `.ref(i)` edge index; null renders
   * the terse single-entity form. Presence marks the target as a reference. */
  refIndex?: number | null;
  /** Copy-instance targets: the slot index of the picked duplicate on the
   * 2D copy() statement at `line` — renders `cp.instance(k)`. Composes with
   * `line`/`role`/`occurrence`; never with `datum`, and v1 never with
   * `refIndex`. */
  instanceIndex?: number;
};

export type SketchConstraintEditSpec = {
  /** 1-indexed line of the sketch() statement. */
  sketchLine: number;
  kind: string;
  targets: SketchConstraintTarget[];
  /** Rendered value expression (already in display units — degrees for angle). */
  valueExpr?: string;
  /** distance only: measure along one axis. */
  axis?: 'x' | 'y';
  /** distance only: far-side circle/arc measurement — renders `.max()`. */
  tangency?: 'max';
};

export async function applySketchConstraint(
  code: string,
  spec: SketchConstraintEditSpec,
): Promise<{ newCode: string; error?: string }> {
  const result = await applySolvedEmission(code, {
    sketchLine: spec.sketchLine,
    geometry: [],
    constraints: [{
      kind: spec.kind,
      targets: spec.targets,
      ...(spec.valueExpr !== undefined ? { valueExpr: spec.valueExpr } : {}),
      ...(spec.axis !== undefined ? { axis: spec.axis } : {}),
      ...(spec.tangency !== undefined ? { tangency: spec.tangency } : {}),
    }],
  });
  return { newCode: result.newCode, ...(result.error !== undefined ? { error: result.error } : {}) };
}
