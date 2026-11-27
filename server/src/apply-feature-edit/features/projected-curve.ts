// project(source, target) outside a sketch: option types, statement rendering, chain parsing and the edit renderer.

import type { TSNode } from '../../code-editor/index.ts';
import type { ChainSegment } from '../ast/chain.ts';
import type { ChainParse, ParsedFeatureStatement } from '../parse/parsed-statement.ts';
import { Directions, type DirectionEdit, type DirectionSpec } from './direction.ts';
import { OperandRows, type RowEdits, type RowPicks } from './operand-rows.ts';
import { WordOption } from './word-option.ts';
import type { ApplyFeatureEditSpec, EditRenderSpec } from '../spec.ts';

/**
 * The callee a projected curve's statement calls. Inside a sketch the same
 * callee is the sketch tool that lays geometry onto the sketch plane
 * (`editableKindOf` tells the two apart).
 */
export const PROJECTED_CURVE_CALLEE = 'project';

/** How each point travels — `.mode()`: the first is the default, written as no chain. */
export const PROJECTION_MODES = ['direction', 'normal'] as const;

/** Which images stay — `.keep()`: the first is the default, written as no chain. */
export const PROJECTION_KEEPS = ['nearest', 'all'] as const;

export type ProjectionMode = typeof PROJECTION_MODES[number];
export type ProjectionKeep = typeof PROJECTION_KEEPS[number];

/** `.mode()`: how each point travels. */
export const PROJECTION_MODE = new WordOption<ProjectionMode>('mode', PROJECTION_MODES);

/** `.keep()`: which images stay. */
export const PROJECTION_KEEP = new WordOption<ProjectionKeep>('keep', PROJECTION_KEEPS);

/**
 * The engine's refusal of a `.direction(…)` with `.mode('normal')`, word for
 * word: the route, the transform and the edit refuse such a statement as the
 * build would.
 */
export const DIRECTION_WITH_NORMAL = `project: .direction() is for mode 'direction'.`;

/** The two arguments of `project(source, target)`. */
export type ProjectedCurveRow = 'source' | 'target';

/**
 * The rows `project(source, target)` is written from: the source a row of
 * curve picks — a sketch or a curve whole by its statement's variable, an
 * edge of a body by its selector — and the target a row of surface picks —
 * a surface whole, a face of a body by its selector — with the words of
 * their refusals.
 */
export const PROJECTED_CURVE_ROWS = new OperandRows<ProjectedCurveRow>({
  callee: PROJECTED_CURVE_CALLEE,
  tool: 'projected curve',
  rows: {
    source: { kind: 'curve', label: 'the source', wants: 'a sketch, a curve or edges' },
    target: { kind: 'surface', label: 'the target', wants: 'a surface or faces' },
  },
  shapeError: 'project() outside a sketch takes the curves and the faces to project them onto as its two arguments — edit it in the source',
});

/** What else than a row's pick may render a selector part: a picked edge or face direction. */
const PART_OWNERS = 'one pick or the direction';

/**
 * How a projected curve statement is rendered and placed:
 * `project(<source>, <target>)`, each argument the picks of one dialog row in
 * pick order — a sketch or a curve whole by its statement's variable, an edge
 * of a body by its selector in the source; a surface whole, a face of a body
 * by its selector in the target; one pick bare, several as a list — then
 * `.mode('normal')`, `.direction(<direction>)` and `.keep('all')`, each only
 * when it is not the default, in that order. `direction` is null when the
 * statement leaves it out (the normal of the plane the source lies in); with
 * mode `'normal'` it must be null. It lands at the end of the scope its picks
 * pin, where a picked edge or face is known to resolve.
 */
export type ProjectedCurveEditOptions = RowPicks<ProjectedCurveRow> & {
  mode: ProjectionMode;
  direction: DirectionSpec | null;
  keep: ProjectionKeep;
};

/**
 * An edit's `.direction(…)`: the statement's own argument kept as written
 * (an absent one too), the chain dropped, or a new direction.
 */
export type ProjectedCurveDirectionEdit = DirectionEdit;

/**
 * An edit of a projected curve: each argument the statement's own, verbatim,
 * while kept (an absent slot too) or re-picked; the mode and what is kept
 * replaced when given, else as the statement has them; the direction kept,
 * cleared or new.
 */
export type ProjectedCurveEdit = RowEdits<ProjectedCurveRow> & {
  mode?: ProjectionMode;
  direction?: ProjectedCurveDirectionEdit;
  keep?: ProjectionKeep;
};

/** The parsed reading of a projected curve statement. */
type ParsedProjectedCurve = Extract<ParsedFeatureStatement, { feature: 'projected-curve' }>;

/** A projected curve's chained options, as a statement writes them. */
type ProjectedCurveChains = {
  mode: ProjectionMode;
  /** The `.direction(…)` argument's text, or null for no chain. */
  direction: string | null;
  keep: ProjectionKeep;
};

/** The statement from its two argument texts and its options, each chain left out at its default, in canonical order. */
function statementOf(args: Record<ProjectedCurveRow, string>, chains: ProjectedCurveChains): string {
  return PROJECTED_CURVE_ROWS.call(args)
    + PROJECTION_MODE.chain(chains.mode)
    + Directions.chain(chains.direction)
    + PROJECTION_KEEP.chain(chains.keep);
}

/**
 * Render a projected curve statement from its rows' picks and its options,
 * each producer under `varFor`'s variable: `.mode('normal')`,
 * `.direction(…)`, `.keep('all')`, each left out at its default. Shared by
 * the route's preview and the transform, so the previewed text is exactly
 * what the transform writes.
 */
export function renderProjectedCurveStatement(
  pc: ProjectedCurveEditOptions,
  parts: ApplyFeatureEditSpec['parts'],
  varFor: (producer: number) => string | null,
): string {
  return statementOf(PROJECTED_CURVE_ROWS.arguments(pc, parts, varFor), {
    mode: pc.mode,
    direction: pc.direction === null ? null : Directions.render(pc.direction, parts, varFor),
    keep: pc.keep,
  });
}

/**
 * Read `project(source, target)` outside a sketch back: each argument's
 * operands — a list's elements, or the bare expression — with the statement a
 * bare variable names, the argument as written, which a kept slot writes
 * again, and the chained options in whatever order they are written. A
 * `.mode()` or `.keep()` whose argument is not one of its words (a variable,
 * another word) has no choice the dialog can show, so the statement is
 * refused; so is anything but two plain arguments.
 */
export function parseProjectedCurveChain(
  args: TSNode[],
  recognized: Map<string, ChainSegment>,
  start: number,
  end: number,
): ChainParse {
  const rows = PROJECTED_CURVE_ROWS.parse(args, start);
  if ('error' in rows) {
    return rows;
  }
  const mode = PROJECTION_MODE.read(recognized.get('mode'));
  if ('error' in mode) {
    return mode;
  }
  const keep = PROJECTION_KEEP.read(recognized.get('keep'));
  if ('error' in keep) {
    return keep;
  }
  const direction = Directions.readChain(recognized.get('direction'));
  if ('error' in direction) {
    return direction;
  }
  return {
    parsed: { feature: 'projected-curve', ...rows, mode: mode.value, directionText: direction.text, keep: keep.value },
    start,
    end,
  };
}

/**
 * Why a create spec cannot be written, or null: the source holds at least
 * one curve pick (a bound sketch or curve statement, or an edge selector
 * part), the target at least one surface pick (a bound surface statement, or
 * a face selector part), the mode and what is kept are among their words, a
 * direction is one of {@link DirectionSpec}'s forms and only in mode
 * `'direction'`, and every selector part belongs to exactly one pick or to
 * the direction.
 */
export function projectedCurveCreateError(spec: ApplyFeatureEditSpec): string | null {
  const pc = spec.projectedCurve;
  if (!pc || !PROJECTION_MODE.has(pc.mode) || !PROJECTION_KEEP.has(pc.keep)) {
    return PROJECTED_CURVE_ROWS.malformed();
  }
  const rows = PROJECTED_CURVE_ROWS.check(pc, spec);
  if ('error' in rows) {
    return rows.error;
  }
  const parts = [...rows.parts];
  if (pc.direction !== null) {
    if (pc.mode === 'normal') {
      return DIRECTION_WITH_NORMAL;
    }
    const direction = Directions.validate(pc.direction, spec);
    if ('error' in direction) {
      return PROJECTED_CURVE_ROWS.malformed(direction.error);
    }
    parts.push(...Directions.parts(direction));
  }
  return PROJECTED_CURVE_ROWS.partsError(parts, spec, PART_OWNERS);
}

/**
 * Render an edited projected curve: each argument the statement's own,
 * verbatim, while it is kept, or its new picks; the mode and what is kept as
 * the edit gives them, else as the statement has them; the direction's own
 * text while it is kept, nothing once cleared, or the new direction. The
 * chains are written in their canonical order. The members after them — a
 * `.name('…')` — are the caller's to keep. A direction left with mode
 * `'normal'`, kept or new, is refused as the engine refuses it.
 */
export function renderEditedProjectedCurve(
  parsed: ParsedProjectedCurve,
  spec: EditRenderSpec,
  varFor: (producer: number) => string | null,
): { statement: string } | { error: string } {
  const edit: ProjectedCurveEdit = spec.edit?.projectedCurve ?? {};
  const mode = edit.mode ?? parsed.mode;
  const keep = edit.keep ?? parsed.keep;
  if (!PROJECTION_MODE.has(mode) || !PROJECTION_KEEP.has(keep)) {
    return { error: PROJECTED_CURVE_ROWS.malformed('bad mode or keep') };
  }
  const rows = PROJECTED_CURVE_ROWS.edited(edit, parsed, spec, varFor);
  if ('error' in rows) {
    return rows;
  }
  const direction = Directions.edited(edit.direction, parsed.directionText, spec, varFor);
  if ('error' in direction) {
    return { error: PROJECTED_CURVE_ROWS.malformed(direction.error) };
  }
  if (mode === 'normal' && direction.text !== null) {
    return { error: DIRECTION_WITH_NORMAL };
  }
  const error = PROJECTED_CURVE_ROWS.partsError([...rows.parts, ...direction.parts], spec, PART_OWNERS);
  return error ? { error } : { statement: statementOf(rows.args, { mode, direction: direction.text, keep }) };
}
