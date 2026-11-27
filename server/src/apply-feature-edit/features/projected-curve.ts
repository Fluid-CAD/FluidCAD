// project(source, target) outside a sketch: option types, statement rendering, chain parsing and the edit renderer.

import type { TSNode } from '../../code-editor/index.ts';
import { choiceArgValue } from '../ast/args.ts';
import type { ChainSegment } from '../ast/chain.ts';
import type { ChainParse, ParsedFeatureStatement } from '../parse/parsed-statement.ts';
import { Directions, type DirectionSpec } from './direction.ts';
import { OperandPicks, type OperandEdit, type OperandPick } from './operand-picks.ts';
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

/**
 * The engine's refusal of a `.direction(…)` with `.mode('normal')`, word for
 * word: the route, the transform and the edit refuse such a statement as the
 * build would.
 */
export const DIRECTION_WITH_NORMAL = `project: .direction() is for mode 'direction'.`;

/** The two arguments of `project(source, target)`, as the refusals name them. */
const SLOTS = { source: 'the source', target: 'the target' } as const;

/** What each argument holds: curves for the source, faces for the target. */
const SLOT_KINDS = { source: 'curve', target: 'surface' } as const;

/** What an empty argument is asked to hold, as a refusal says it. */
const WANTS = { source: 'a sketch, a curve or edges', target: 'a surface or faces' } as const;

type Slot = keyof typeof SLOTS;

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
export type ProjectedCurveEditOptions = {
  source: OperandPick[];
  target: OperandPick[];
  mode: ProjectionMode;
  direction: DirectionSpec | null;
  keep: ProjectionKeep;
};

/**
 * An edit's `.direction(…)`: the statement's own argument kept as written
 * (an absent one too), the chain dropped, or a new direction.
 */
export type ProjectedCurveDirectionEdit = { kind: 'keep' } | { kind: 'cleared' } | DirectionSpec;

/**
 * An edit of a projected curve: each argument the statement's own, verbatim,
 * while kept (an absent slot too) or re-picked; the mode and what is kept
 * replaced when given, else as the statement has them; the direction kept,
 * cleared or new.
 */
export type ProjectedCurveEdit = {
  source?: OperandEdit;
  target?: OperandEdit;
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

/**
 * Render a projected curve statement from its two argument texts (see
 * {@link OperandPicks.argument}) and its options: `.mode('normal')`,
 * `.direction(…)`, `.keep('all')`, each left out at its default. Shared with
 * the route's preview so the previewed text is exactly what the transform
 * writes.
 */
export function renderProjectedCurveStatement(source: string, target: string, chains: ProjectedCurveChains): string {
  let statement = `${PROJECTED_CURVE_CALLEE}(${source}, ${target})`;
  if (chains.mode !== PROJECTION_MODES[0]) {
    statement += `.mode('${chains.mode}')`;
  }
  if (chains.direction !== null) {
    statement += `.direction(${chains.direction})`;
  }
  if (chains.keep !== PROJECTION_KEEPS[0]) {
    statement += `.keep('${chains.keep}')`;
  }
  return statement;
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
  if (args.length !== 2 || args.some(arg => arg.type === 'spread_element')) {
    return { error: 'project() outside a sketch takes the curves and the faces to project them onto as its two arguments — edit it in the source' };
  }
  const mode = readChoice(recognized.get('mode'), 'mode', PROJECTION_MODES);
  if ('error' in mode) {
    return mode;
  }
  const keep = readChoice(recognized.get('keep'), 'keep', PROJECTION_KEEPS);
  if ('error' in keep) {
    return keep;
  }
  const directionSeg = recognized.get('direction');
  if (directionSeg && (directionSeg.args.length !== 1 || directionSeg.args[0].type === 'spread_element')) {
    return { error: 'the .direction() chain has an argument shape the dialog cannot edit — edit it in the source' };
  }
  const source = OperandPicks.parse(args[0], start);
  const target = OperandPicks.parse(args[1], start);
  return {
    parsed: {
      feature: 'projected-curve',
      sourceTexts: source.texts,
      sourceRefs: source.refs,
      targetTexts: target.texts,
      targetRefs: target.refs,
      sourceArg: args[0].text,
      targetArg: args[1].text,
      mode: mode.value,
      directionText: directionSeg ? directionSeg.args[0].text : null,
      keep: keep.value,
    },
    start,
    end,
  };
}

/** A `.mode()` / `.keep()` chain's word: the default when the chain is absent. */
function readChoice<T extends string>(
  segment: ChainSegment | undefined,
  name: string,
  choices: readonly T[],
): { value: T } | { error: string } {
  if (!segment) {
    return { value: choices[0] };
  }
  const value = segment.args.length === 1 ? choiceArgValue(segment.args[0], choices) : null;
  if (value === null) {
    const words = choices.map(choice => `'${choice}'`).join(' or ');
    return { error: `the .${name}() argument is not ${words} — edit it in the source` };
  }
  return { value };
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
  if (!pc || !(PROJECTION_MODES as readonly unknown[]).includes(pc.mode)
    || !(PROJECTION_KEEPS as readonly unknown[]).includes(pc.keep)) {
    return 'malformed projected curve edit spec';
  }
  const parts: number[] = [];
  for (const slot of ['source', 'target'] as const) {
    const picks = slotPicks(slot, pc[slot], spec);
    if ('error' in picks) {
      return picks.error;
    }
    parts.push(...selectorParts(picks));
  }
  if (pc.direction !== null) {
    if (pc.mode === 'normal') {
      return DIRECTION_WITH_NORMAL;
    }
    const direction = Directions.validate(pc.direction, spec);
    if ('error' in direction) {
      return `malformed projected curve edit spec: ${direction.error}`;
    }
    parts.push(...directionParts(direction));
  }
  return partsError(parts, spec);
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
  if (!(PROJECTION_MODES as readonly unknown[]).includes(mode) || !(PROJECTION_KEEPS as readonly unknown[]).includes(keep)) {
    return { error: 'malformed projected curve edit spec: bad mode or keep' };
  }
  const name = (producer: number): string | null => varFor(producer) ?? spec.producers[producer].nameHint ?? null;
  const parts: number[] = [];
  const args: string[] = [];
  for (const slot of ['source', 'target'] as const) {
    const slotEdit = edit[slot];
    if (slotEdit === undefined || slotEdit.kind === 'keep') {
      args.push(slot === 'source' ? parsed.sourceArg : parsed.targetArg);
      continue;
    }
    if (slotEdit.kind !== 'picks') {
      return { error: `malformed projected curve edit spec: ${SLOTS[slot]} is neither kept nor picked` };
    }
    const picks = slotPicks(slot, slotEdit.picks, spec);
    if ('error' in picks) {
      return picks;
    }
    parts.push(...selectorParts(picks));
    args.push(OperandPicks.argument(OperandPicks.render(picks, spec.parts, name)));
  }
  let direction: string | null;
  const directionEdit = edit.direction;
  if (directionEdit === undefined || directionEdit.kind === 'keep') {
    direction = parsed.directionText;
  } else if (directionEdit.kind === 'cleared') {
    direction = null;
  } else {
    const valid = Directions.validate(directionEdit, spec);
    if ('error' in valid) {
      return { error: `malformed projected curve edit spec: ${valid.error}` };
    }
    parts.push(...directionParts(valid));
    direction = Directions.render(valid, spec.parts, name);
  }
  if (mode === 'normal' && direction !== null) {
    return { error: DIRECTION_WITH_NORMAL };
  }
  const error = partsError(parts, spec);
  if (error) {
    return { error };
  }
  return { statement: renderProjectedCurveStatement(args[0], args[1], { mode, direction, keep }) };
}

/** One argument's picks, checked as a curve (source) or surface (target) operand's: a refusal names the slot, an empty one says so. */
function slotPicks(
  slot: Slot,
  picks: unknown,
  spec: Pick<ApplyFeatureEditSpec, 'producers' | 'parts'>,
): OperandPick[] | { error: string } {
  const valid = OperandPicks.validate(SLOT_KINDS[slot], picks, SLOTS[slot], spec);
  if ('error' in valid) {
    return { error: `malformed projected curve edit spec: ${valid.error}` };
  }
  if (valid.length === 0) {
    return { error: `project: ${SLOTS[slot]} is empty — pick ${WANTS[slot]} for it` };
  }
  return valid;
}

function selectorParts(picks: OperandPick[]): number[] {
  return picks.flatMap(pick => pick.kind === 'selector' ? [pick.part] : []);
}

/** The selector part a picked edge or face direction renders, if it is one. */
function directionParts(direction: DirectionSpec): number[] {
  return direction.kind === 'edge' || direction.kind === 'face' ? [direction.part ?? 0] : [];
}

/** Every selector part belongs to exactly one pick or the direction: a part nothing renders would be lost. */
function partsError(parts: number[], spec: Pick<ApplyFeatureEditSpec, 'parts'>): string | null {
  return parts.length === spec.parts.length && new Set(parts).size === parts.length
    ? null
    : 'malformed projected curve edit spec: every selector part belongs to exactly one pick or the direction';
}
