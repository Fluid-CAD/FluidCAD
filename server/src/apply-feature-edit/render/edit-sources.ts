// Resolving an edit spec's kept-or-replaced sources into the variables and selector arguments a re-render uses.

import { isWireProducer } from '../producers/predicates.ts';
import { renderSelectorPartExpr } from './selectors.ts';
import type { ApplyFeatureEditSpec, EditRenderSpec } from '../spec.ts';

/**
 * The selector argument list an edited statement renders: the user's
 * expression text wins over a re-picked selection (the create path's
 * contract), and with neither the statement's own args stay verbatim.
 */
export function editedSelectorArgs(
  spec: EditRenderSpec,
  argsText: string,
  varFor: (producer: number) => string | null,
): string {
  const partsArgs = spec.parts.length > 0
    ? spec.parts
      .map(part => renderSelectorPartExpr(part, part.producer === null ? null : varFor(part.producer), varFor))
      .join(', ')
    : null;
  return spec.rawArgs?.trim() || partsArgs || argsText;
}

/**
 * Variable text of a re-sourced sketch/wire slot: the binding's name, else
 * the hint. The route types each slot's producer ('sketch' for profiles,
 * 'wire' for paths/guides, 'offset' for an extrude's face-offset profile —
 * `allowOffset` opts that in for exactly that slot), so accepting these here
 * stays sound — the callee check happens where the producer binds.
 */
export function editSourceVar(
  spec: EditRenderSpec,
  producer: number,
  varFor: (producer: number) => string | null,
  allowOffset = false,
): string | { error: string } {
  const offsetProducer = allowOffset
    && Number.isInteger(producer) && producer >= 0 && producer < spec.producers.length
    && spec.producers[producer].featureType === 'offset';
  if (!offsetProducer && !isWireProducer(spec as ApplyFeatureEditSpec, producer)) {
    return { error: 'malformed edit spec: a re-sourced slot references a non-sketch producer' };
  }
  return varFor(producer) ?? spec.producers[producer].nameHint ?? 's';
}
