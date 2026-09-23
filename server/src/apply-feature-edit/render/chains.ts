// Shared chain fragments: .scope(), .region() and the cut/remove/new operation chains.

import { formatValue, type RegionKey, type ValueExpr } from '../value-expr.ts';

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
 * A region key as a single-quoted JS string literal. Keys only ever hold
 * `[\w$#\[\].\- ]`, but a quote or backslash that did slip in must not
 * break the statement, so both are escaped.
 */
function quoteRegionKey(key: string): string {
  return `'${key.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/**
 * The `.region(…)` chain of a swept feature — the picked regions of its
 * profile, keys quoted and positions bare, right after the call so it reads
 * as what the operation builds before how it builds it. Absent or empty
 * writes nothing: the operation takes every region.
 */
export function renderRegionChain(keys: RegionKey[] | undefined): string {
  if (!keys || keys.length === 0) {
    return '';
  }
  return `.region(${keys.map(key => typeof key === 'number' ? String(key) : quoteRegionKey(key)).join(', ')})`;
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
