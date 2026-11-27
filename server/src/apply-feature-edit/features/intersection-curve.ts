// intersect(first, second) outside a sketch: option types, statement rendering, chain parsing and the edit renderer.

import type { TSNode } from '../../code-editor/index.ts';
import type { ChainParse, ParsedFeatureStatement } from '../parse/parsed-statement.ts';
import { OperandPicks, type OperandEdit, type OperandPick } from './operand-picks.ts';
import type { ApplyFeatureEditSpec, EditRenderSpec } from '../spec.ts';

/**
 * The callee an intersection curve's statement calls. Inside a sketch the
 * same callee is the sketch tool that sections with the sketch plane
 * (`editableKindOf` tells the two apart).
 */
export const INTERSECTION_CURVE_CALLEE = 'intersect';

/** The two arguments of `intersect(first, second)`, as the refusals name them. */
const SLOTS = { first: 'the first selection', second: 'the second selection' } as const;

type Slot = keyof typeof SLOTS;

/**
 * How an intersection curve statement is rendered and placed:
 * `intersect(<first>, <second>)`, each argument the picks of one dialog row
 * in pick order — a surface whole, by its statement's variable, a face of a
 * body by its selector; one pick bare, several as a list. The tool has no
 * options, so the statement has no chains. It lands at the end of the scope
 * its picks pin, where a picked face is known to resolve.
 */
export type IntersectionCurveEditOptions = {
  first: OperandPick[];
  second: OperandPick[];
};

/**
 * An edit's two slots: each the statement's own argument kept as written
 * (an absent slot too), or re-picked.
 */
export type IntersectionCurveEdit = { first?: OperandEdit; second?: OperandEdit };

/** The parsed reading of an intersection curve statement. */
type ParsedIntersectionCurve = Extract<ParsedFeatureStatement, { feature: 'intersection-curve' }>;

/**
 * Render an intersection curve statement from its two argument texts (see
 * {@link OperandPicks.argument}). Shared with the route's preview so the
 * previewed text is exactly what the transform writes.
 */
export function renderIntersectionCurveStatement(first: string, second: string): string {
  return `${INTERSECTION_CURVE_CALLEE}(${first}, ${second})`;
}

/**
 * Read `intersect(first, second)` back: each argument's operands — a
 * list's elements, or the bare expression — with the statement a bare
 * variable names, and the argument as written, which a kept slot writes
 * again. Anything but two plain arguments is not a form the dialog shows.
 */
export function parseIntersectionCurveChain(args: TSNode[], start: number, end: number): ChainParse {
  if (args.length !== 2 || args.some(arg => arg.type === 'spread_element')) {
    return { error: 'intersect() outside a sketch takes the two sets of faces as its two arguments — edit it in the source' };
  }
  const first = OperandPicks.parse(args[0], start);
  const second = OperandPicks.parse(args[1], start);
  return {
    parsed: {
      feature: 'intersection-curve',
      firstTexts: first.texts,
      firstRefs: first.refs,
      secondTexts: second.texts,
      secondRefs: second.refs,
      firstArg: args[0].text,
      secondArg: args[1].text,
    },
    start,
    end,
  };
}

/**
 * Why a create spec cannot be written, or null: both slots hold at least
 * one pick of a surface (a bound surface statement) or a face (a selector
 * part), and every selector part belongs to exactly one pick.
 */
export function intersectionCurveCreateError(spec: ApplyFeatureEditSpec): string | null {
  const ic = spec.intersectionCurve;
  if (!ic) {
    return 'malformed intersection curve edit spec';
  }
  const parts: number[] = [];
  for (const slot of ['first', 'second'] as const) {
    const picks = slotPicks(slot, ic[slot], spec);
    if ('error' in picks) {
      return picks.error;
    }
    parts.push(...selectorParts(picks));
  }
  return partsError(parts, spec);
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
  const edit: IntersectionCurveEdit = spec.edit?.intersectionCurve ?? {};
  const parts: number[] = [];
  const args: string[] = [];
  for (const slot of ['first', 'second'] as const) {
    const slotEdit = edit[slot];
    if (slotEdit === undefined || slotEdit.kind === 'keep') {
      args.push(slot === 'first' ? parsed.firstArg : parsed.secondArg);
      continue;
    }
    if (slotEdit.kind !== 'picks') {
      return { error: `malformed intersection curve edit spec: ${SLOTS[slot]} is neither kept nor picked` };
    }
    const picks = slotPicks(slot, slotEdit.picks, spec);
    if ('error' in picks) {
      return picks;
    }
    parts.push(...selectorParts(picks));
    args.push(OperandPicks.argument(OperandPicks.render(
      picks, spec.parts, producer => varFor(producer) ?? spec.producers[producer].nameHint ?? null,
    )));
  }
  const error = partsError(parts, spec);
  if (error) {
    return { error };
  }
  return { statement: renderIntersectionCurveStatement(args[0], args[1]) };
}

/** One slot's picks, checked as a surface operand's: a refusal names the slot, an empty one says so. */
function slotPicks(
  slot: Slot,
  picks: unknown,
  spec: Pick<ApplyFeatureEditSpec, 'producers' | 'parts'>,
): OperandPick[] | { error: string } {
  const valid = OperandPicks.validate('surface', picks, SLOTS[slot], spec);
  if ('error' in valid) {
    return { error: `malformed intersection curve edit spec: ${valid.error}` };
  }
  if (valid.length === 0) {
    return { error: `intersect: ${SLOTS[slot]} is empty — pick a surface or faces for it` };
  }
  return valid;
}

function selectorParts(picks: OperandPick[]): number[] {
  return picks.flatMap(pick => pick.kind === 'selector' ? [pick.part] : []);
}

/** Every selector part belongs to exactly one pick: a part no pick renders would be lost. */
function partsError(parts: number[], spec: Pick<ApplyFeatureEditSpec, 'parts'>): string | null {
  return parts.length === spec.parts.length && new Set(parts).size === parts.length
    ? null
    : 'malformed intersection curve edit spec: every selector part belongs to exactly one pick';
}
