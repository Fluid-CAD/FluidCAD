// Shared chain fragments: .scope(), .region() and the cut/remove/new operation chains.

import { formatValue, type RegionName, type ValueExpr } from '../value-expr.ts';

/** The `.thin(…)` / `.remove()` / `.new()` chains shared by sweep and loft. */
/**
 * Render the `.scope(…)` chain from its target expressions; an empty list
 * renders nothing (whole-scene fusion, the kernel default). Always the LAST
 * chain — `.remove()`/`.new()` reset the fusion scope, so the scope must be
 * written after them to survive.
 */
export function renderScopeChain(scopeExprs: string[]): string {
  return scopeExprs.length > 0 ? `.scope(${scopeExprs.join(', ')})` : '';
}

/**
 * A region name as a single-quoted JS string literal. Names are plain
 * identifiers in practice, but a quote or backslash that did slip in must
 * not break the statement, so both are escaped.
 */
export function quoteRegionName(name: string): string {
  return `'${name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/**
 * The `.region(…)` chain of a swept feature — the picked regions of its
 * profile by the names their declarations gave them, right after the call
 * so it reads as what the operation builds before how it builds it. Absent
 * or empty writes nothing: the operation takes every region.
 */
export function renderRegionChain(names: RegionName[] | undefined): string {
  if (!names || names.length === 0) {
    return '';
  }
  return `.region(${names.map(quoteRegionName).join(', ')})`;
}

export function renderOpChains(opts: {
  op: 'add' | 'remove' | 'new';
  thin: [ValueExpr] | [ValueExpr, ValueExpr] | null;
}, scopeExprs: string[] = []): string {
  let chains = '';
  if (opts.thin) {
    chains += `.thin(${opts.thin.map(formatValue).join(', ')})`;
  }
  if (opts.op === 'remove') {
    chains += '.remove()';
  } else if (opts.op === 'new') {
    chains += '.new()';
  }
  return chains + renderScopeChain(scopeExprs);
}
