// sweep(): option types, statement rendering and the extend-segment parser.

import { anyValueArg, stringArgValue } from '../ast/args.ts';
import type { ChainSegment } from '../ast/chain.ts';
import { renderOpChains, renderRegionChain } from '../render/chains.ts';
import { formatValue, type RegionKey, type ValueExpr } from '../value-expr.ts';

/**
 * How a sweep statement is rendered and placed: `sweep(<path>[, <profile>])`
 * plus `.extend(…)` / `.thin(…)` / `.remove()` / `.new()` chains. The profile is a sketch —
 * `implicit` consumes the last sketch (an anchor-only producer verifies it),
 * `{producer}` binds that sketch to a variable. The path is either a bound
 * sketch producer or the selector rendered from `parts` (edge picks). The
 * statement always inserts at end of scope, where an implicit profile is
 * the last sketch and a selector path is known to resolve.
 */
export type SweepEditOptions = {
  op: 'add' | 'remove' | 'new';
  thin: [ValueExpr] | [ValueExpr, ValueExpr] | null;
  /** `.extend('start', …)` lead-in before the path; null or absent writes none. */
  extendStart?: ValueExpr | null;
  /** `.extend('end', …)` run-out past the path; null or absent writes none. */
  extendEnd?: ValueExpr | null;
  profile: 'implicit' | { producer: number };
  path: { kind: 'sketch'; producer: number } | { kind: 'selector' };
  /** Producer indices of the `.scope(…)` targets, in pick order. */
  scope?: number[];
  /**
   * The `.region(…)` picks — the keys of the profile regions the operation
   * builds. Absent or empty writes no chain (every region).
   */
  regions?: RegionKey[];
};

/**
 * Render a sweep statement: `sweep(<path>[, <profile>])` plus `.extend(…)`,
 * `.thin(…)` and the `.remove()` / `.new()` / `.scope(…)` operation chains. Shared with the
 * route's preview so the previewed text is exactly what the transform writes.
 */
export function renderSweepStatement(
  sw: Pick<SweepEditOptions, 'op' | 'thin' | 'extendStart' | 'extendEnd' | 'regions'>,
  pathExpr: string,
  profileVar: string | null,
  scopeExprs: string[] = [],
): string {
  const args = [pathExpr];
  if (profileVar) {
    args.push(profileVar);
  }
  return `sweep(${args.join(', ')})` + renderRegionChain(sw.regions)
    + renderSweepExtendChains(sw) + renderOpChains(sw, scopeExprs);
}

/**
 * The `.extend('start', …)` / `.extend('end', …)` chains, start first. They
 * describe the spine, so they precede the profile (`.thin`) and operation
 * chains; an absent or null amount writes nothing for that end.
 */
function renderSweepExtendChains(sw: Pick<SweepEditOptions, 'extendStart' | 'extendEnd'>): string {
  let chains = '';
  if (sw.extendStart != null) {
    chains += `.extend('start', ${formatValue(sw.extendStart)})`;
  }
  if (sw.extendEnd != null) {
    chains += `.extend('end', ${formatValue(sw.extendEnd)})`;
  }
  return chains;
}

/**
 * Read the feature chain rooted at `call` into its dialog-editable options.
 * `start`/`end` span the chain root through its last recognized option
 * member — the range an edit replaces; a `const x = ` binding before it and
 * unrecognized chained calls after it survive untouched.
 */
/**
 * Read a chain's recognized `.scope(…)` member into its parsed texts + refs
 * (both empty when the chain is absent) — shared by every feature that
 * writes one (rib, extrude, sweep, loft, revolve).
 */
/**
 * The sweep's `.extend(side, amount)` chains — at most one per side, the side
 * a plain `'start'`/`'end'` string literal and the amount a number or
 * expression. Anything else is left to the source editor.
 */
export function parseSweepExtendSegments(
  segments: ChainSegment[],
): { extendStart: ValueExpr | null; extendEnd: ValueExpr | null } | { error: string } {
  let extendStart: ValueExpr | null = null;
  let extendEnd: ValueExpr | null = null;
  for (const segment of segments) {
    if (segment.args.length !== 2) {
      return { error: 'the .extend() chain has an argument shape the dialog cannot edit' };
    }
    const side = stringArgValue(segment.args[0]);
    if (side !== 'start' && side !== 'end') {
      return { error: "the .extend() side is not a plain 'start' or 'end' — edit the statement in the source" };
    }
    const amount = anyValueArg(segment.args[1]);
    if (amount === null) {
      return { error: 'the .extend() amount is not a plain number or expression — edit it in the source' };
    }
    if (side === 'start') {
      if (extendStart !== null) {
        return { error: "the statement chains .extend('start') twice" };
      }
      extendStart = amount;
    } else {
      if (extendEnd !== null) {
        return { error: "the statement chains .extend('end') twice" };
      }
      extendEnd = amount;
    }
  }
  return { extendStart, extendEnd };
}
