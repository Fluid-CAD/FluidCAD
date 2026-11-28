// bridge(from, to): option types, statement rendering, chain parsing, the edit renderer and the staging of its sketch point ends.

import type { TSNode } from '../../code-editor/index.ts';
import { anyValueArg, choiceArgValue, resolveRepeatTargetRef } from '../ast/args.ts';
import type { ChainSegment } from '../ast/chain.ts';
import type { ChainParse, ParsedFeatureStatement } from '../parse/parsed-statement.ts';
import type { ApplyFeatureEditSpec, EditRenderSpec } from '../spec.ts';
import { formatValue, validValueExpr, type ValueExpr } from '../value-expr.ts';
import { EndSpecs, type EndEdit, type EndSpec } from './end.ts';
import { WordOption } from './word-option.ts';

/** The callee a bridge's statement calls. */
export const BRIDGE_CALLEE = 'bridge';

/** How the bridge meets an end: position, tangent (the default, first) or curvature. */
export const BRIDGE_CONTINUITIES = ['g1', 'g0', 'g2'] as const;

export type BridgeContinuity = typeof BRIDGE_CONTINUITIES[number];

/** `.continuity()` with one value: the chain for both ends alike, nothing at the default. */
export const BRIDGE_CONTINUITY = new WordOption<BridgeContinuity>('continuity', BRIDGE_CONTINUITIES);

/**
 * The engine's refusal of a magnitude that is not above zero, word for
 * word: the route, the transform and the edit refuse a literal zero or a
 * negative number at an end the statement writes a magnitude for, as the
 * build would.
 */
export const BRIDGE_MAGNITUDE_NOT_POSITIVE = 'bridge: a magnitude must be greater than zero.';

/** The two ends of `bridge(from, to)`, as a refusal names them. */
const SLOTS = { from: 'the from end', to: 'the to end' } as const;

/**
 * How a bridge statement is rendered and placed: `bridge(<from>, <to>)` —
 * each end an edge's selector or a curve's variable with `.start()` /
 * `.end()`, or a point (a solid's corner as the end of the edge that names
 * it, a sketch point through its sketch) — then `.continuity(…)`, left out
 * when both ends are `'g1'`, one value when both ends are alike, the start's
 * and the end's when they differ; then `.startMagnitude(n)` and
 * `.endMagnitude(n)`, each left out at 1 and at an end met at `'g0'`, where
 * it does nothing. It lands at the end of the scope its picks pin.
 */
export type BridgeEditOptions = {
  from: EndSpec;
  to: EndSpec;
  startContinuity: BridgeContinuity;
  endContinuity: BridgeContinuity;
  startMagnitude: ValueExpr;
  endMagnitude: ValueExpr;
};

/**
 * An edit of a bridge: each end the statement's own, verbatim, while kept
 * (an absent one too) or a new end; the continuity at each end and each
 * magnitude replaced when given, else as the statement has it.
 */
export type BridgeEdit = {
  from?: EndEdit;
  to?: EndEdit;
  startContinuity?: BridgeContinuity;
  endContinuity?: BridgeContinuity;
  startMagnitude?: ValueExpr;
  endMagnitude?: ValueExpr;
};

/** The parsed reading of a bridge statement. */
type ParsedBridge = Extract<ParsedFeatureStatement, { feature: 'bridge' }>;

/** A bridge's chained options as a statement writes them: each magnitude's text, or null for none. */
type BridgeChains = {
  startContinuity: BridgeContinuity;
  endContinuity: BridgeContinuity;
  startMagnitude: string | null;
  endMagnitude: string | null;
};

/** The `.continuity(…)` chain for the two ends: nothing when both are `'g1'`, one value when alike, two when they differ. */
function continuityChain(start: BridgeContinuity, end: BridgeContinuity): string {
  return start === end ? BRIDGE_CONTINUITY.chain(start) : `.continuity('${start}', '${end}')`;
}

/** The statement from its two end texts and its options, each chain left out at its default, in canonical order. */
function statementOf(from: string, to: string, chains: BridgeChains): string {
  return `${BRIDGE_CALLEE}(${from}, ${to})`
    + continuityChain(chains.startContinuity, chains.endContinuity)
    + (chains.startMagnitude === null ? '' : `.startMagnitude(${chains.startMagnitude})`)
    + (chains.endMagnitude === null ? '' : `.endMagnitude(${chains.endMagnitude})`);
}

/** Whether a magnitude is the default, 1, as a literal: what a statement leaves out. */
function isDefaultMagnitude(value: ValueExpr): boolean {
  const text = String(value).trim();
  return text !== '' && Number(text) === 1;
}

/**
 * Why a magnitude cannot be written at an end the statement writes one for,
 * or null: a number or an expression (`m`, `k * 2`) — and not a literal
 * zero or a negative number, refused in the engine's words.
 */
export function bridgeMagnitudeError(magnitude: unknown, field: string): string | null {
  if (!validValueExpr(magnitude)) {
    return `${field} must be a number or expression`;
  }
  const text = String(magnitude).trim();
  const literal = Number(text);
  return text !== '' && Number.isFinite(literal) && literal <= 0 ? BRIDGE_MAGNITUDE_NOT_POSITIVE : null;
}

/**
 * The magnitude an end writes: nothing at an end met at `'g0'` — it does
 * nothing there — nor at the default; else its text. The refusal of a
 * value that cannot be written, in the engine's words for a literal zero or
 * a negative number.
 */
function writtenMagnitude(
  continuity: BridgeContinuity,
  value: ValueExpr,
  text: string,
  field: string,
): { text: string | null } | { error: string } {
  if (continuity === 'g0') {
    return { text: null };
  }
  const error = bridgeMagnitudeError(value, field);
  if (error !== null) {
    return { error };
  }
  return { text: isDefaultMagnitude(value) ? null : text };
}

/** The refusal of a spec the dialog does not send, with what is wrong when given. */
function malformed(detail?: string): string {
  return detail === undefined ? 'malformed bridge edit spec' : `malformed bridge edit spec: ${detail}`;
}

/** Why the selector parts the ends render do not account for the spec's, or null: each part rendered exactly once. */
function partsError(parts: number[], spec: Pick<ApplyFeatureEditSpec, 'parts'>): string | null {
  return parts.length === spec.parts.length && new Set(parts).size === parts.length
    ? null
    : malformed('every selector part belongs to exactly one end');
}

/** An end's expression for a statement being created; a sketch point reaches here staged, or the request was not. */
function endText(end: EndSpec, parts: ApplyFeatureEditSpec['parts'], varFor: (producer: number) => string | null): string {
  const text = EndSpecs.render(end, parts, varFor);
  if (text === null) {
    throw new Error('a bridge end that is a sketch point was not staged before the statement was rendered');
  }
  return text;
}

/**
 * Render a bridge statement from its ends and its options, each producer
 * under `varFor`'s variable: `.continuity(…)`, `.startMagnitude(…)`,
 * `.endMagnitude(…)`, each left out at its default, a magnitude also at an
 * end met at `'g0'`. Shared by the route's preview and the transform, so the
 * previewed text is exactly what the transform writes. Its ends are staged
 * first: a sketch point is named by its export.
 */
export function renderBridgeStatement(
  bridge: BridgeEditOptions,
  parts: ApplyFeatureEditSpec['parts'],
  varFor: (producer: number) => string | null,
): string {
  const start = bridge.startContinuity === 'g0' || isDefaultMagnitude(bridge.startMagnitude) ? null : formatValue(bridge.startMagnitude);
  const end = bridge.endContinuity === 'g0' || isDefaultMagnitude(bridge.endMagnitude) ? null : formatValue(bridge.endMagnitude);
  return statementOf(endText(bridge.from, parts, varFor), endText(bridge.to, parts, varFor), {
    startContinuity: bridge.startContinuity,
    endContinuity: bridge.endContinuity,
    startMagnitude: start,
    endMagnitude: end,
  });
}

/**
 * Reads `.continuity(…)` back: `'g1'` at both ends when the statement
 * leaves it out, one string literal for both, or two — the start's and the
 * end's. Any other argument — another word, a variable, an expression, a
 * spread — or count has no choice the dialog can show, so the statement is
 * refused.
 */
function readContinuity(segment: ChainSegment | undefined): { start: BridgeContinuity; end: BridgeContinuity } | { error: string } {
  if (!segment) {
    return { start: 'g1', end: 'g1' };
  }
  const args = segment.args;
  if (args.length < 1 || args.length > 2 || args.some(arg => arg.type === 'spread_element')) {
    return { error: 'the .continuity() chain takes one value for both ends, or the start\'s and the end\'s — edit it in the source' };
  }
  const values = args.map(arg => choiceArgValue(arg, BRIDGE_CONTINUITIES));
  if (values.some(value => value === null)) {
    return { error: `the .continuity() argument is not 'g0', 'g1' or 'g2' — edit it in the source` };
  }
  const [start, end] = values as BridgeContinuity[];
  return { start, end: end ?? start };
}

/**
 * Reads a magnitude chain back: 1 and no text when the statement leaves it
 * out, else the number or the expression computing it, and the argument as
 * written — what an edit that leaves it writes back. Anything but one
 * plain argument is refused.
 */
function readMagnitude(segment: ChainSegment | undefined, method: string): { value: ValueExpr; arg: string | null } | { error: string } {
  if (!segment) {
    return { value: 1, arg: null };
  }
  const value = segment.args.length === 1 && segment.args[0].type !== 'spread_element' ? anyValueArg(segment.args[0]) : null;
  if (value === null) {
    return { error: `the .${method}() argument is not a plain number or expression — edit it in the source` };
  }
  return { value, arg: segment.args[0].text };
}

/**
 * Read `bridge(from, to)` back: each end verbatim, with the statement a
 * bare variable names; the continuity at each end; each magnitude as a
 * number or the expression computing it, and as written. The chains may
 * come in any order. Anything but two plain arguments is refused, and so
 * is a chain the dialog cannot show.
 */
export function parseBridgeChain(
  args: TSNode[],
  recognized: Map<string, ChainSegment>,
  start: number,
  end: number,
): ChainParse {
  if (args.length !== 2 || args.some(arg => arg.type === 'spread_element')) {
    return { error: 'bridge() takes the two ends it joins as its two arguments — edit it in the source' };
  }
  const continuity = readContinuity(recognized.get('continuity'));
  if ('error' in continuity) {
    return continuity;
  }
  const startMagnitude = readMagnitude(recognized.get('startMagnitude'), 'startMagnitude');
  if ('error' in startMagnitude) {
    return startMagnitude;
  }
  const endMagnitude = readMagnitude(recognized.get('endMagnitude'), 'endMagnitude');
  if ('error' in endMagnitude) {
    return endMagnitude;
  }
  return {
    parsed: {
      feature: 'bridge',
      fromText: args[0].text,
      toText: args[1].text,
      fromRef: resolveRepeatTargetRef(args[0], start),
      toRef: resolveRepeatTargetRef(args[1], start),
      startContinuity: continuity.start,
      endContinuity: continuity.end,
      startMagnitude: startMagnitude.value,
      endMagnitude: endMagnitude.value,
      startMagnitudeArg: startMagnitude.arg,
      endMagnitudeArg: endMagnitude.arg,
    },
    start,
    end,
  };
}

/**
 * Why a create spec cannot be written, or null: each end one of
 * {@link EndSpec}'s kinds the spec holds, a sketch point already staged
 * into its expression; each continuity among its words; each magnitude at
 * an end not met at `'g0'` a number or an expression, and no literal zero
 * or negative number (refused as the engine refuses it); every selector
 * part rendered by exactly one end.
 */
export function bridgeCreateError(spec: ApplyFeatureEditSpec): string | null {
  const bridge = spec.bridge;
  if (!bridge || !BRIDGE_CONTINUITY.has(bridge.startContinuity) || !BRIDGE_CONTINUITY.has(bridge.endContinuity)) {
    return malformed();
  }
  const parts: number[] = [];
  for (const slot of ['from', 'to'] as const) {
    const end = EndSpecs.validate(bridge[slot], spec, SLOTS[slot]);
    if ('error' in end) {
      return malformed(end.error);
    }
    if (EndSpecs.isSketchPoint(end)) {
      return malformed(`${SLOTS[slot]} names a sketch point whose export was not staged`);
    }
    parts.push(...EndSpecs.parts(end));
  }
  for (const [continuity, magnitude, field] of [
    [bridge.startContinuity, bridge.startMagnitude, 'startMagnitude'],
    [bridge.endContinuity, bridge.endMagnitude, 'endMagnitude'],
  ] as const) {
    const error = continuity === 'g0' ? null : bridgeMagnitudeError(magnitude, field);
    if (error !== null) {
      return error === BRIDGE_MAGNITUDE_NOT_POSITIVE ? error : malformed(error);
    }
  }
  return partsError(parts, spec);
}

/**
 * Render an edited bridge: each end the statement's own, verbatim, while
 * it is kept, or the new end; the continuity at each end as the edit gives
 * it, else as the statement has it; each magnitude as the edit gives it,
 * else as written — and none at an end now met at `'g0'`. The chains are
 * written in their canonical order with their defaults left out. The
 * members after them — a `.name('…')` — are the caller's to keep. A
 * magnitude left a literal zero or a negative number at an end that writes
 * one, kept or new, is refused as the engine refuses it.
 */
export function renderEditedBridge(
  parsed: ParsedBridge,
  spec: EditRenderSpec,
  varFor: (producer: number) => string | null,
): { statement: string } | { error: string } {
  const edit: BridgeEdit = spec.edit?.bridge ?? {};
  const startContinuity = edit.startContinuity ?? parsed.startContinuity;
  const endContinuity = edit.endContinuity ?? parsed.endContinuity;
  if (!BRIDGE_CONTINUITY.has(startContinuity) || !BRIDGE_CONTINUITY.has(endContinuity)) {
    return { error: malformed('bad continuity') };
  }
  const from = EndSpecs.edited(edit.from, parsed.fromText, spec, varFor, SLOTS.from);
  if ('error' in from) {
    return { error: malformed(from.error) };
  }
  const to = EndSpecs.edited(edit.to, parsed.toText, spec, varFor, SLOTS.to);
  if ('error' in to) {
    return { error: malformed(to.error) };
  }
  const magnitudes: (string | null)[] = [];
  for (const [continuity, given, value, arg, field] of [
    [startContinuity, edit.startMagnitude, parsed.startMagnitude, parsed.startMagnitudeArg, 'startMagnitude'],
    [endContinuity, edit.endMagnitude, parsed.endMagnitude, parsed.endMagnitudeArg, 'endMagnitude'],
  ] as const) {
    const magnitude = given !== undefined
      ? writtenMagnitude(continuity, given, formatValue(given), field)
      : arg === null ? { text: null } : writtenMagnitude(continuity, value, arg, field);
    if ('error' in magnitude) {
      return { error: magnitude.error === BRIDGE_MAGNITUDE_NOT_POSITIVE ? magnitude.error : malformed(magnitude.error) };
    }
    magnitudes.push(magnitude.text);
  }
  const error = partsError([...from.parts, ...to.parts], spec);
  if (error) {
    return { error };
  }
  return {
    statement: statementOf(from.text, to.text, {
      startContinuity,
      endContinuity,
      startMagnitude: magnitudes[0],
      endMagnitude: magnitudes[1],
    }),
  };
}

/**
 * A bridge's ends that are sketch points are named through their sketches'
 * return values (`s.geometries.p1`), which may not exist yet: the exports
 * are authored first, in one pass against the original buffer — as a
 * hole's sketch points and a loft's connections are — and the spec then
 * names each by its expression, so an Apply is one write and a refusal
 * never leaves a half-edited file.
 */
export class BridgeEnds {
  /** The ends a create or an edit spec carries: the new ones of an edit, absent for a kept one. */
  private static ends(spec: ApplyFeatureEditSpec): [EndEdit | undefined, EndEdit | undefined] {
    const ends = spec.edit ? spec.edit.bridge : spec.bridge;
    return [ends?.from, ends?.to];
  }

  /** Whether the spec's bridge has an end a sketch must export first. */
  static needsStaging(spec: ApplyFeatureEditSpec): boolean {
    return spec.feature === 'bridge' && BridgeEnds.ends(spec).some(EndSpecs.isSketchPoint);
  }

  /** Author every export the spec's sketch point ends need; the spec comes back naming each by its expression. */
  static async prepare(code: string, spec: ApplyFeatureEditSpec): Promise<{ code: string; spec: ApplyFeatureEditSpec } | { error: string }> {
    if (!BridgeEnds.needsStaging(spec)) {
      return { code, spec };
    }
    const staged = await EndSpecs.stage(code, spec, BridgeEnds.ends(spec));
    if ('error' in staged) {
      return staged;
    }
    const [from, to] = staged.ends;
    const ends = { ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}) };
    const next = staged.spec;
    return {
      code: staged.code,
      spec: next.edit
        ? { ...next, edit: { ...next.edit, bridge: { ...next.edit.bridge, ...ends } } }
        : { ...next, bridge: { ...next.bridge!, ...ends } as BridgeEditOptions },
    };
  }
}
