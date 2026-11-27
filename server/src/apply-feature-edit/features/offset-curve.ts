// offset(distance, edges, { on: faces }) outside a sketch: option types, statement rendering, chain parsing and the edit renderer.

import type { TSNode } from '../../code-editor/index.ts';
import { anyValueArg } from '../ast/args.ts';
import type { ChainParse, ParsedFeatureStatement } from '../parse/parsed-statement.ts';
import { OperandRows, type RowEdits, type RowPicks } from './operand-rows.ts';
import type { ApplyFeatureEditSpec, EditRenderSpec } from '../spec.ts';
import { formatValue, validValueExpr, type ValueExpr } from '../value-expr.ts';

/**
 * The callee an offset curve's statement calls. Inside a sketch the same
 * callee is the sketch tool, and outside one with no trailing object it
 * outlines faces (`editableKindOf` tells the three apart).
 */
export const OFFSET_CURVE_CALLEE = 'offset';

/**
 * The engine's refusal of a zero distance, word for word: the route, the
 * transform and the edit refuse a literal zero as the build would.
 */
export const ZERO_OFFSET_DISTANCE = 'offset: the distance is zero.';

/** The two rows of `offset(distance, edges, { on })`: the argument and the option. */
export type OffsetCurveRow = 'edges' | 'on';

/**
 * The rows `offset(distance, edges, { on })` is written from, after its
 * distance: the edges a row of curve picks — a sketch or a curve whole by
 * its statement's variable, an edge of a body by its selector — and `on` a
 * row of surface picks written as the options object's one entry — a
 * surface whole, a face of a body by its selector — with the words of their
 * refusals.
 */
export const OFFSET_CURVE_ROWS = new OperandRows<OffsetCurveRow>({
  callee: OFFSET_CURVE_CALLEE,
  tool: 'offset curve',
  values: ['distance'],
  rows: {
    edges: { kind: 'curve', label: 'the edges row', wants: 'a sketch, a curve or edges' },
    on: { kind: 'surface', label: '{ on }', wants: 'the faces the curve lies on', option: true },
  },
  shapeError: 'offset() with { on } takes the distance, the edges and { on: faces } as its three arguments — edit it in the source',
  optionsError: 'offset: the only option is { on: faces } — edit it in the source',
});

/**
 * How an offset curve statement is rendered and placed: `offset(<distance>,
 * <edges>, { on: <faces> })` — the distance a number or an expression, its
 * sign the side (positive to the left of the edges); each row the picks of
 * one dialog row in pick order, a sketch or a curve whole by its statement's
 * variable, an edge or a face of a body by its selector, one pick bare,
 * several as a list. The tool has no chained options. It lands at the end of
 * the scope its picks pin, where a picked edge or face is known to resolve.
 */
export type OffsetCurveEditOptions = RowPicks<OffsetCurveRow> & {
  distance: ValueExpr;
};

/**
 * An edit of an offset curve: each row the statement's own, verbatim, while
 * kept (an absent row too) or re-picked; the distance replaced when given,
 * else as written.
 */
export type OffsetCurveEdit = RowEdits<OffsetCurveRow> & {
  distance?: ValueExpr;
};

/** The parsed reading of an offset curve statement. */
type ParsedOffsetCurve = Extract<ParsedFeatureStatement, { feature: 'offset-curve' }>;

/**
 * Why a distance cannot be written, or null: a number or an expression
 * (`d`, `h / 2`) — and not a literal zero, refused in the engine's words.
 */
export function offsetCurveDistanceError(distance: unknown): string | null {
  if (!validValueExpr(distance)) {
    return 'distance must be a number or expression';
  }
  const text = String(distance).trim();
  return text !== '' && Number(text) === 0 ? ZERO_OFFSET_DISTANCE : null;
}

/**
 * Render an offset curve statement from its distance and its rows' picks,
 * each producer under `varFor`'s variable. Shared by the route's preview and
 * the transform, so the previewed text is exactly what the transform writes.
 */
export function renderOffsetCurveStatement(
  oc: OffsetCurveEditOptions,
  parts: ApplyFeatureEditSpec['parts'],
  varFor: (producer: number) => string | null,
): string {
  return OFFSET_CURVE_ROWS.call(OFFSET_CURVE_ROWS.arguments(oc, parts, varFor), [formatValue(oc.distance)]);
}

/**
 * Read `offset(distance, edges, { on })` back: the distance as a number or
 * the expression computing it, and as written; each row's operands — a
 * list's elements, or the bare expression; a shorthand `{ on }` its
 * variable — with the statement a bare variable names, and the row as
 * written, which a kept row writes again. Anything but three plain
 * arguments, an options object holding anything but `on`, or a distance no
 * dialog field can hold is refused.
 */
export function parseOffsetCurveChain(args: TSNode[], start: number, end: number): ChainParse {
  const rows = OFFSET_CURVE_ROWS.parse(args, start);
  if ('error' in rows) {
    return rows;
  }
  const distance = anyValueArg(args[0]);
  if (distance === null) {
    return { error: 'the offset distance is not a plain number or expression — edit it in the source' };
  }
  return { parsed: { feature: 'offset-curve', distance, distanceArg: args[0].text, ...rows }, start, end };
}

/**
 * Why a create spec cannot be written, or null: the distance a number or an
 * expression and no literal zero (refused as the engine refuses it), the
 * edges at least one curve pick (a bound sketch or curve statement, or an
 * edge selector part), `on` at least one surface pick (a bound surface
 * statement, or a face selector part), and every selector part belonging to
 * exactly one pick.
 */
export function offsetCurveCreateError(spec: ApplyFeatureEditSpec): string | null {
  const oc = spec.offsetCurve;
  if (!oc) {
    return OFFSET_CURVE_ROWS.malformed();
  }
  const distance = offsetCurveDistanceError(oc.distance);
  if (distance !== null) {
    return distance === ZERO_OFFSET_DISTANCE ? distance : OFFSET_CURVE_ROWS.malformed(distance);
  }
  const rows = OFFSET_CURVE_ROWS.check(oc, spec);
  return 'error' in rows ? rows.error : OFFSET_CURVE_ROWS.partsError(rows.parts, spec);
}

/**
 * Render an edited offset curve: the distance as the edit gives it, else as
 * written; each row the statement's own, verbatim, while it is kept, or its
 * new picks. The members after the call — a `.name('…')` — are the caller's
 * to keep. A distance left a literal zero, kept or new, is refused as the
 * engine refuses it.
 */
export function renderEditedOffsetCurve(
  parsed: ParsedOffsetCurve,
  spec: EditRenderSpec,
  varFor: (producer: number) => string | null,
): { statement: string } | { error: string } {
  const edit: OffsetCurveEdit = spec.edit?.offsetCurve ?? {};
  const distance = offsetCurveDistanceError(edit.distance ?? parsed.distance);
  if (distance !== null) {
    return { error: distance === ZERO_OFFSET_DISTANCE ? distance : OFFSET_CURVE_ROWS.malformed(distance) };
  }
  const rows = OFFSET_CURVE_ROWS.edited(edit, parsed, spec, varFor);
  if ('error' in rows) {
    return rows;
  }
  const error = OFFSET_CURVE_ROWS.partsError(rows.parts, spec);
  if (error) {
    return { error };
  }
  return { statement: OFFSET_CURVE_ROWS.call(rows.args, [edit.distance === undefined ? parsed.distanceArg : formatValue(edit.distance)]) };
}
