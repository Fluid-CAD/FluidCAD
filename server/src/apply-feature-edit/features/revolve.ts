// revolve(): option types, statement rendering and axis expressions.

import { renderOpChains, renderRegionChain } from '../render/chains.ts';
import { renderSelectorPartExpr } from '../render/selectors.ts';
import type { ApplyFeatureEditSpec } from '../spec.ts';
import { formatValue, type RegionKey, type ValueExpr } from '../value-expr.ts';

/**
 * One revolve axis: a standard world axis (renders as its string literal, no
 * producer involved), an existing axis statement bound to a variable, or a
 * picked edge — the single selector part wrapped in `axis(…)`.
 */
export type RevolveAxisSpec =
  | { kind: 'standard'; axis: 'x' | 'y' | 'z' }
  | { kind: 'axis'; producer: number }
  | { kind: 'selector' };

/**
 * How a revolve statement is rendered and placed: `revolve(<axis>[, <angle>]
 * [, <profile>])` plus `.thin(…)` / `.remove()` / `.new()` chains. The angle
 * is in degrees; 360 (the API default) renders no argument. The profile is a
 * sketch — `implicit` consumes the last sketch, `bound` binds producers[0] to
 * a variable (the extrude contract: the profile is always producers[0]). A
 * standard axis renders no producer; an axis-statement input binds its
 * producer to a variable; a picked edge renders the single selector part
 * wrapped in `axis(…)`. The statement always inserts at end of scope, where
 * a picked edge is known to resolve and an implicit profile is the last
 * sketch.
 */
export type RevolveEditOptions = {
  op: 'add' | 'remove' | 'new';
  /** Sweep angle in degrees; 360 renders no angle argument. */
  angle: ValueExpr;
  /** `.symmetric()` — the sweep splits equally across the sketch plane. */
  symmetric: boolean;
  thin: [ValueExpr] | [ValueExpr, ValueExpr] | null;
  profile: 'implicit' | 'bound';
  axis: RevolveAxisSpec;
  /** Producer indices of the `.scope(…)` targets, in pick order. */
  scope?: number[];
  /**
   * The `.region(…)` picks — the keys of the profile regions the operation
   * builds. Absent or empty writes no chain (every region).
   */
  regions?: RegionKey[];
};

/**
 * Render a revolve statement: `revolve(<axis>[, <angle>][, <profile>])` plus
 * `.symmetric()`, `.thin(…)` and the `.remove()` / `.new()` / `.scope(…)`
 * operation chains. The 360° API default renders no angle argument. Shared
 * with the route's preview so the previewed text is exactly what the
 * transform writes.
 */
export function renderRevolveStatement(
  rev: Pick<RevolveEditOptions, 'op' | 'angle' | 'symmetric' | 'thin' | 'regions'>,
  axisExpr: string,
  profileExpr: string | null,
  scopeExprs: string[] = [],
): string {
  const args = [axisExpr];
  if (rev.angle !== 360) {
    args.push(formatValue(rev.angle));
  }
  if (profileExpr) {
    args.push(profileExpr);
  }
  const symmetric = rev.symmetric ? '.symmetric()' : '';
  return `revolve(${args.join(', ')})` + renderRegionChain(rev.regions) + symmetric
    + renderOpChains(rev, scopeExprs);
}

/**
 * Render a revolve's axis argument: `'z'` for a standard world axis, the
 * bound variable for an existing axis statement, or the picked edge's
 * selector part wrapped in `axis(…)`. Shared with the route, which passes
 * its namer's variables; the transform passes its bindings'.
 */
export function renderRevolveAxisExpr(
  axis: RevolveAxisSpec,
  parts: ApplyFeatureEditSpec['parts'],
  varFor: (producer: number) => string | null,
): string {
  if (axis.kind === 'standard') {
    return `'${axis.axis}'`;
  }
  if (axis.kind === 'axis') {
    return varFor(axis.producer) ?? 'a';
  }
  const part = parts[0];
  return `axis(${renderSelectorPartExpr(part, part.producer === null ? null : varFor(part.producer), varFor)})`;
}
