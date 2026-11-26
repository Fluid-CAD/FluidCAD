// helix(): option types, chain rendering and source expressions.

import { SelectorText } from '../parse/selector-text.ts';
import { Directions, type DirectionSpec } from './direction.ts';
import type { ApplyFeatureEditSpec } from '../spec.ts';
import { formatValue, type ValueExpr } from '../value-expr.ts';

/**
 * One helix source: a standard world axis (its string literal, no producer),
 * an existing axis statement bound to a variable, a picked edge — the single
 * selector part wrapped in `axis(…)` — a connector, or a picked
 * cylindrical/conical face, the single selector part on its own. The forms
 * of a {@link DirectionSpec} that name an axis or a face: a helix winds
 * around a line or on a face, never along a plane's normal.
 */
export type HelixSourceSpec = Exclude<DirectionSpec, { kind: 'standard-plane' } | { kind: 'plane' }>;

/**
 * How a helix statement is rendered and placed: `helix(<source>)` plus its
 * chained geometry configurators (`.radius()`, `.endRadius()`, `.pitch()`,
 * `.turns()`, `.height()`, `.startOffset()`, `.endOffset()`), each omitted when
 * null. A helix is a wire, so there is no add/remove/new operation. A standard
 * axis renders no producer; an axis-statement source binds its producer to a
 * variable; a picked edge or face renders the single selector part (an edge
 * wrapped in `axis(…)`). The statement always inserts at end of scope, where
 * a picked selector is known to resolve.
 */
export type HelixEditOptions = {
  source: HelixSourceSpec;
  radius: ValueExpr | null;
  endRadius: ValueExpr | null;
  pitch: ValueExpr | null;
  turns: ValueExpr | null;
  height: ValueExpr | null;
  startOffset: ValueExpr | null;
  endOffset: ValueExpr | null;
};

/** A helix's chained geometry configurators — shared by its create and edit payloads. */
type HelixChainOptions = {
  radius: ValueExpr | null;
  endRadius: ValueExpr | null;
  pitch: ValueExpr | null;
  turns: ValueExpr | null;
  height: ValueExpr | null;
  startOffset: ValueExpr | null;
  endOffset: ValueExpr | null;
};

/**
 * Render a helix's chained configurators in canonical order — `.radius()`,
 * `.endRadius()`, `.pitch()`, `.turns()`, `.height()`, `.startOffset()`,
 * `.endOffset()` — each omitted when null.
 */
function renderHelixChains(hx: HelixChainOptions): string {
  let chains = '';
  if (hx.radius !== null) {
    chains += `.radius(${formatValue(hx.radius)})`;
  }
  if (hx.endRadius !== null) {
    chains += `.endRadius(${formatValue(hx.endRadius)})`;
  }
  if (hx.pitch !== null) {
    chains += `.pitch(${formatValue(hx.pitch)})`;
  }
  if (hx.turns !== null) {
    chains += `.turns(${formatValue(hx.turns)})`;
  }
  if (hx.height !== null) {
    chains += `.height(${formatValue(hx.height)})`;
  }
  if (hx.startOffset !== null) {
    chains += `.startOffset(${formatValue(hx.startOffset)})`;
  }
  if (hx.endOffset !== null) {
    chains += `.endOffset(${formatValue(hx.endOffset)})`;
  }
  return chains;
}

/**
 * Render a helix statement: `helix(<source>)` plus its geometry chains. Shared
 * with the route's preview so the previewed text is exactly what the transform
 * writes.
 */
export function renderHelixStatement(hx: HelixChainOptions, sourceExpr: string): string {
  return `helix(${sourceExpr})` + renderHelixChains(hx);
}

/**
 * Render a helix's source argument: `'z'` for a standard world axis, the bound
 * variable for an axis statement, the picked edge's selector wrapped in
 * `axis(…)`, or the picked face's selector on its own. Shared with the route,
 * which passes its namer's variables; the transform passes its bindings'.
 */
export function renderHelixSourceExpr(
  source: HelixSourceSpec,
  parts: ApplyFeatureEditSpec['parts'],
  varFor: (producer: number) => string | null,
): string {
  // Every form is written as a direction is; a picked edge alone differs,
  // named as the axis it gives.
  const expr = Directions.render(source, parts, varFor);
  return source.kind === 'edge' ? `axis(${expr})` : expr;
}

/**
 * Which tab the helix edit dialog opens on, from the source text alone: a face
 * selector (a `face(...)` filter or any face bucket's accessor, see
 * {@link SelectorText}) reads as 'face'; a standard-axis literal, an
 * `axis(...)` call, or an axis variable reads as 'axis'. A misread is one tab
 * click to correct.
 */
export function classifyHelixSource(text: string): 'axis' | 'face' {
  if (SelectorText.namesFaces(text.trim())) {
    return 'face';
  }
  return 'axis';
}
