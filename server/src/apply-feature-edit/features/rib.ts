// rib(): option types and statement rendering.

import { renderScopeChain } from '../render/chains.ts';
import { formatValue, type ValueExpr } from '../value-expr.ts';

/**
 * How a rib statement is rendered and placed: `rib(<thickness>[, <spine>])`
 * plus `.parallel()` / `.extend()` / `.draft(…)` / `.remove()` / `.new()` /
 * `.scope(…)` chains. The spine is a sketch — `implicit` consumes the last
 * sketch, `bound` binds it to a variable (always producers[0]). Scope entries
 * are the solid-bearing statements the rib conforms to and fuses with, each
 * bound to a variable (featureType `feature` producers, following the spine
 * in the list). The statement always inserts at end of scope, where an
 * implicit spine is the last sketch.
 */
export type RibEditOptions = {
  op: 'add' | 'remove' | 'new';
  /** Wall thickness; the sign picks the side of the sketch plane. */
  thickness: ValueExpr;
  /** `.parallel()` — extrude in-plane, perpendicular to the spine. */
  parallel: boolean;
  /** `.extend()` — push the spine endpoints out into the surrounding walls. */
  extend: boolean;
  /** `.draft(angle)` taper in degrees, or null for straight walls. */
  draft: ValueExpr | null;
  spine: 'implicit' | 'bound';
  /** Producer indices of the `.scope(…)` targets, in pick order. */
  scope: number[];
};

/**
 * Render a rib statement from its options: `rib(5)` for an implicit spine /
 * `rib(5, s)` for a bound one — plus `.parallel()` / `.extend()` /
 * `.draft(…)` / `.remove()` / `.new()` / `.scope(…)` chains, in that order
 * (the docs' canonical shape). Shared with the route's preview so the
 * previewed text is exactly what the transform writes.
 */
export function renderRibStatement(
  rib: Pick<RibEditOptions, 'op' | 'thickness' | 'parallel' | 'extend' | 'draft'>,
  spineVar: string | null,
  scopeExprs: string[],
): string {
  const callArgs = [formatValue(rib.thickness)];
  if (spineVar !== null) {
    callArgs.push(spineVar);
  }
  let statement = `rib(${callArgs.join(', ')})`;
  if (rib.parallel) {
    statement += '.parallel()';
  }
  if (rib.extend) {
    statement += '.extend()';
  }
  if (rib.draft !== null) {
    statement += `.draft(${formatValue(rib.draft)})`;
  }
  if (rib.op === 'remove') {
    statement += '.remove()';
  } else if (rib.op === 'new') {
    statement += '.new()';
  }
  return statement + renderScopeChain(scopeExprs);
}
