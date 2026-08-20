// Constraint-statement emission for solved sketches (sketch-rewrite P4).
//
// The toolbar's "add constraint" rides the generic apply-feature-edit round
// trip as a self-contained sub-spec (the segmentSwap/paramEdit pattern —
// both editor hosts already speak the transport). Since P5 the actual
// transform lives in sketch-solved-edit.ts (which also emits geometry);
// a constraint-only edit is an emission with no geometry.

import {
  applySolvedEmission,
  type SolvedEmissionRole,
} from './sketch-solved-edit.ts';
import type { SolvedEntityKind } from './sketch-symbols.ts';

export type SketchConstraintTarget = {
  /** 1-indexed line of the entity statement. */
  line: number;
  /** Point accessor rendered as `.role()`; absent = the entity itself. */
  role?: SolvedEmissionRole;
  /** The entity command the statement must call — a mismatch means the
   * source changed under the picks and refuses the edit. */
  featureType?: SolvedEntityKind;
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
    }],
  });
  return { newCode: result.newCode, ...(result.error !== undefined ? { error: result.error } : {}) };
}
