// rib request validation.

import { validValueExpr, type ValueExpr } from '../../../apply-feature-edit/index.ts';
import { validateScopeLocs, validateSketchLoc, type SketchLoc } from '../locations.ts';

/** The dialog-editable rib options, shared by the create and edit paths. */
type RibOptionSet = {
  op: 'add' | 'remove' | 'new';
  thickness: ValueExpr;
  parallel: boolean;
  extend: boolean;
  draft: ValueExpr | null;
};

/**
 * The rib request's shape. The spine is a sketch — `active` consumes it
 * implicitly, `bound` binds it to a variable. `scope` names the solid-bearing
 * statements the rib conforms to and fuses with (whole-solid picks); empty
 * writes no `.scope(…)` chain and the rib fuses with the whole scene.
 */
type RibRequest = RibOptionSet & {
  spine: { mode: 'active' | 'bound' } & SketchLoc;
  scope: SketchLoc[];
};

/**
 * Validate the option fields both rib requests carry: the boolean op, the
 * signed nonzero thickness (the sign picks the side of the sketch plane),
 * the parallel / extend toggles and the draft chain.
 */
export function validateRibOptions(body: any): RibOptionSet | { error: string } {
  const { op, thickness, parallel, extend, draft } = body ?? {};
  if (op !== 'add' && op !== 'remove' && op !== 'new') {
    return { error: 'op must be "add", "remove" or "new"' };
  }
  if (!validValueExpr(thickness, { nonzero: true })) {
    return { error: 'thickness must be a nonzero number or expression (negative ribs the other way)' };
  }
  if (parallel !== undefined && typeof parallel !== 'boolean') {
    return { error: 'parallel must be a boolean' };
  }
  if (extend !== undefined && typeof extend !== 'boolean') {
    return { error: 'extend must be a boolean' };
  }
  if (draft !== undefined && draft !== null && !validValueExpr(draft, { nonzero: true })) {
    return { error: 'draft must be a nonzero taper angle in degrees' };
  }
  return {
    op,
    thickness,
    parallel: parallel === true,
    extend: extend === true,
    draft: draft ?? null,
  };
}

export function validateRib(body: any): RibRequest | { error: string } {
  const options = validateRibOptions(body);
  if ('error' in options) {
    return options;
  }
  const mode = body?.spine?.mode;
  const loc = validateSketchLoc(body?.spine);
  if ((mode !== 'active' && mode !== 'bound') || !loc) {
    return { error: 'spine must be {mode: "active"|"bound", filePath, line} of the sketch' };
  }
  const scopeResult = validateScopeLocs(body);
  if ('error' in scopeResult) {
    return scopeResult;
  }
  return { ...options, spine: { mode, ...loc }, scope: scopeResult.scope };
}
