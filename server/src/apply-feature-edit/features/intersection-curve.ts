// intersect(first, second) outside a sketch: option types, statement rendering, chain parsing and the edit renderer.

import type { TSNode } from '../../code-editor/index.ts';
import type { ChainParse, ParsedFeatureStatement } from '../parse/parsed-statement.ts';
import { OperandRows, type RowEdits, type RowPicks } from './operand-rows.ts';
import type { ApplyFeatureEditSpec, EditRenderSpec } from '../spec.ts';

/**
 * The callee an intersection curve's statement calls. Inside a sketch the
 * same callee is the sketch tool that sections with the sketch plane
 * (`editableKindOf` tells the two apart).
 */
export const INTERSECTION_CURVE_CALLEE = 'intersect';

/** The two arguments of `intersect(first, second)`. */
export type IntersectionCurveRow = 'first' | 'second';

/**
 * The rows `intersect(first, second)` is written from: two rows of surface
 * picks — a surface whole, by its statement's variable, a face of a body by
 * its selector — and the words of their refusals.
 */
export const INTERSECTION_CURVE_ROWS = new OperandRows<IntersectionCurveRow>({
  callee: INTERSECTION_CURVE_CALLEE,
  tool: 'intersection curve',
  rows: {
    first: { kind: 'surface', label: 'the first selection', wants: 'a surface or faces' },
    second: { kind: 'surface', label: 'the second selection', wants: 'a surface or faces' },
  },
  shapeError: 'intersect() outside a sketch takes the two sets of faces as its two arguments — edit it in the source',
});

/**
 * How an intersection curve statement is rendered and placed:
 * `intersect(<first>, <second>)`, each argument the picks of one dialog row
 * in pick order — a surface whole, by its statement's variable, a face of a
 * body by its selector; one pick bare, several as a list. The tool has no
 * options, so the statement has no chains. It lands at the end of the scope
 * its picks pin, where a picked face is known to resolve.
 */
export type IntersectionCurveEditOptions = RowPicks<IntersectionCurveRow>;

/**
 * An edit's two slots: each the statement's own argument kept as written
 * (an absent slot too), or re-picked.
 */
export type IntersectionCurveEdit = RowEdits<IntersectionCurveRow>;

/** The parsed reading of an intersection curve statement. */
type ParsedIntersectionCurve = Extract<ParsedFeatureStatement, { feature: 'intersection-curve' }>;

/**
 * Render an intersection curve statement from its two rows' picks, each
 * producer under `varFor`'s variable. Shared by the route's preview and the
 * transform, so the previewed text is exactly what the transform writes.
 */
export function renderIntersectionCurveStatement(
  ic: IntersectionCurveEditOptions,
  parts: ApplyFeatureEditSpec['parts'],
  varFor: (producer: number) => string | null,
): string {
  return INTERSECTION_CURVE_ROWS.call(INTERSECTION_CURVE_ROWS.arguments(ic, parts, varFor));
}

/**
 * Read `intersect(first, second)` back: each argument's operands — a
 * list's elements, or the bare expression — with the statement a bare
 * variable names, and the argument as written, which a kept slot writes
 * again. Anything but two plain arguments is not a form the dialog shows.
 */
export function parseIntersectionCurveChain(args: TSNode[], start: number, end: number): ChainParse {
  const rows = INTERSECTION_CURVE_ROWS.parse(args, start);
  return 'error' in rows ? rows : { parsed: { feature: 'intersection-curve', ...rows }, start, end };
}

/**
 * Why a create spec cannot be written, or null: both slots hold at least
 * one pick of a surface (a bound surface statement) or a face (a selector
 * part), and every selector part belongs to exactly one pick.
 */
export function intersectionCurveCreateError(spec: ApplyFeatureEditSpec): string | null {
  const ic = spec.intersectionCurve;
  if (!ic) {
    return INTERSECTION_CURVE_ROWS.malformed();
  }
  const rows = INTERSECTION_CURVE_ROWS.check(ic, spec);
  return 'error' in rows ? rows.error : INTERSECTION_CURVE_ROWS.partsError(rows.parts, spec);
}

/**
 * Render an edited intersection curve: each slot the statement's own
 * argument, verbatim, while it is kept, or its new picks. The chains after
 * the call — a `.name('…')` — are the caller's to keep.
 */
export function renderEditedIntersectionCurve(
  parsed: ParsedIntersectionCurve,
  spec: EditRenderSpec,
  varFor: (producer: number) => string | null,
): { statement: string } | { error: string } {
  const rows = INTERSECTION_CURVE_ROWS.edited(spec.edit?.intersectionCurve ?? {}, parsed, spec, varFor);
  if ('error' in rows) {
    return rows;
  }
  const error = INTERSECTION_CURVE_ROWS.partsError(rows.parts, spec);
  return error ? { error } : { statement: INTERSECTION_CURVE_ROWS.call(rows.args) };
}
