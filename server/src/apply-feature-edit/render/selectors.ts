// Selector-part expressions and raw selector arguments, with the imports they need.

import type { ProducerBinding } from '../producers/bindings.ts';
import type { ApplyFeatureEditSpec } from '../spec.ts';

/**
 * Render one selector part as an expression: `select(<args>)` for a global
 * part, `<var>.<accessor>(<args>)` on a bound producer. Shared with the
 * route, which renders loft profiles part-by-part with the namer's names.
 * `refVarFor` resolves the producers `filterArgs` references through
 * `{{r<n>}}` tokens (plane-reference selectors) to their bound variables.
 */
export function renderSelectorPartExpr(
  part: ApplyFeatureEditSpec['parts'][number],
  producerVar: string | null,
  refVarFor?: (producer: number) => string | null,
): string {
  let selectorArgs = part.indices ? part.indices.join(', ') : (part.filterArgs ?? '');
  (part.refs ?? []).forEach((ref, i) => {
    const name = refVarFor?.(ref);
    if (name) {
      selectorArgs = selectorArgs.split(`{{r${i}}}`).join(name);
    }
  });
  if (part.producer === null) {
    // 'filter' parts are bare edge-filter arguments (2D ops accept them
    // directly); everything else producer-less is a global select().
    if (part.accessor === 'filter') {
      return selectorArgs;
    }
    return `select(${selectorArgs})`;
  }
  // An empty accessor names the whole feature (`fillet(4, l)`).
  if (part.accessor === '') {
    return `${producerVar}`;
  }
  return `${producerVar}.${part.accessor}(${selectorArgs})`;
}

/** The selector argument list: the user-edited override, or rendered parts. */
/**
 * The statement's argument list: the user's verbatim override when one is
 * set, else the rendered selector parts followed by `extraArgs` (a
 * projection's resolved cross-part references).
 */
export function renderSelectorArgs(
  spec: ApplyFeatureEditSpec,
  bindings: ProducerBinding[],
  extraArgs: string[] = [],
): string {
  const rawArgs = spec.rawArgs?.trim();
  if (rawArgs) {
    return rawArgs;
  }
  return [
    ...spec.parts.map(part =>
      renderSelectorPartExpr(part, part.producer === null ? null : bindings[part.producer].varName, i => bindings[i].varName)),
    ...extraArgs,
  ].join(', ');
}

export const MODULE_FOR_IMPORT: Record<string, string> = {
  select: 'fluidcad/core',
  edge: 'fluidcad/filters',
  face: 'fluidcad/filters',
  axis: 'fluidcad/core',
  plane: 'fluidcad/core',
  param: 'fluidcad/core',
};

/**
 * Symbols a user-edited argument list references. The synthesized path
 * computes imports kernel-side; an override is free text, so they are
 * re-derived here from the same three call spellings.
 */
export function importsForRawArgs(rawArgs: string): string[] {
  const symbols: string[] = [];
  for (const symbol of Object.keys(MODULE_FOR_IMPORT)) {
    if (new RegExp(`\\b${symbol}\\(`).test(rawArgs)) {
      symbols.push(symbol);
    }
  }
  return symbols;
}
