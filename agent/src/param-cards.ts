// Parameter cards (`offer_params`, docs/agent-chat-plan.md §26): which of the
// model's parameters a call puts on the card, what the model is told about
// them, and what a page may report as kept.
//
// A card holds no value of its own. A control sets a session override in the
// engine (`POST api/set-param`), Keep writes the values into the source
// through the Parameters panel's own route (`POST api/params/value`) and
// Reset drops the overrides (`POST api/reset-params`): all three are the
// page's calls, the user's own actions. The session only puts the card in
// the transcript and, once the page reports what Keep wrote, tells the agent
// with the next message.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { MAX_OFFERED_PARAMS, type OfferParamsInput } from '../../mcp/dist/server.js';
import type { AgentHostDeps } from '../../server/dist/agent-host.js';
import type { ParamCardItem, ParamCardValue, ParamChange, ParamKeptValue, ParamsPart } from './types.ts';

/** A parameter of the model on screen, as its last render declared it. */
export type ModelParam = ReturnType<NonNullable<AgentHostDeps['modelParams']>>[number];

/** The model on screen and what it declares: what a card is made from. */
export type ParamCardModel = {
  /** The model file on screen, absolute; null when none is open. */
  file: string | null;
  params: ModelParam[];
};

/** The longest text value a page may report as kept. */
const MAX_KEPT_TEXT_CHARS = 2000;
/** The most values of a multi-select a page may report as kept. */
const MAX_KEPT_LIST = 200;

/** The control a parameter is drawn with, as the Parameters panel draws it. */
type ParamControl = 'number' | 'slider' | 'text' | 'select' | 'checkbox' | 'color';

/** One parameter as `offer_params` describes it to the model. */
type DescribedParam = {
  label: string;
  part?: string;
  type: ParamControl;
  value: ParamCardValue;
  /** The declared default, when the value on screen is another (a session value, a configuration's). */
  default?: ParamCardValue;
  min?: number;
  max?: number;
  step?: number;
  /** A select's values. */
  options?: (string | number)[];
  multi?: true;
};

export type ReadOffer =
  | { ok: true; card: Omit<ParamsPart, 'type' | 'id'>; described: DescribedParam[] }
  | { ok: false; error: string };

/**
 * The card a call makes of the model on screen, or what is wrong with the
 * call in words the model can correct it from: a label the model does not
 * declare (with the ones it does), a label two parts declare named without
 * its part, a project parameter, more parameters than a card shows.
 * `relative` makes a path workspace-relative.
 */
export function readOffer(input: OfferParamsInput, model: ParamCardModel, relative: (absPath: string) => string): ReadOffer {
  if (!model.file) {
    return { ok: false, error: 'No model is on screen, so there are no parameters to offer.' };
  }
  const file = relative(model.file);
  // A project parameter has no session value (its literal is its value in every file): not a card's to offer.
  const own = model.params.filter((p) => p.kind !== 'global');
  const globals = model.params.filter((p) => p.kind === 'global');
  if (own.length === 0) {
    return {
      ok: false,
      error:
        `The model on screen (${file}) declares no parameters in a part() or assembly() body, so there is nothing to offer.` +
        (globals.length > 0 ? ' Its project parameters (*.params.js) are edited in the Parameters column, not on a card.' : ''),
    };
  }
  const declared = `The model on screen (${file}) declares: ${own.map(describe).join(', ')}.`;

  let chosen: ModelParam[];
  if (!input.params || input.params.length === 0) {
    if (own.length > MAX_OFFERED_PARAMS) {
      return {
        ok: false,
        error: `The model on screen declares ${own.length} parameters, more than a card shows (${MAX_OFFERED_PARAMS}). Name the few the user is likely to tune in \`params\`. ${declared}`,
      };
    }
    chosen = own;
  } else {
    chosen = [];
    const problems: string[] = [];
    for (const wanted of input.params) {
      const label = wanted.label.trim();
      const part = wanted.part?.trim() || undefined;
      const matches = own.filter((p) => p.label === label && (part === undefined || p.body === part));
      if (matches.length === 1) {
        if (!chosen.includes(matches[0])) {
          chosen.push(matches[0]);
        }
      } else if (matches.length > 1) {
        problems.push(`${quote(label)} is declared by ${matches.map((p) => quote(p.body ?? '')).join(' and ')}: name the one you mean with \`part\`.`);
      } else if (globals.some((p) => p.label === label)) {
        problems.push(`${quote(label)} is a project parameter (a *.params.js file): a card offers the model's own parameters only.`);
      } else {
        problems.push(`No parameter labelled ${quote(label)}${part ? ` in ${quote(part)}` : ''}.`);
      }
    }
    if (problems.length > 0) {
      return { ok: false, error: `${problems.join(' ')} ${declared}` };
    }
  }

  const note = input.note?.replace(/\s+/g, ' ').trim();
  return {
    ok: true,
    card: {
      file,
      absPath: model.file,
      ...(note ? { note } : {}),
      params: chosen.map((p): ParamCardItem => ({ label: p.label, ...(p.body !== undefined ? { part: p.body } : {}) })),
    },
    described: chosen.map(describedParam),
  };
}

/** What `offer_params` returns: the card's file and parameters, with their ranges. */
export function offerResult(read: Extract<ReadOffer, { ok: true }>): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ file: read.card.file, params: read.described }) }] };
}

/**
 * What a page reports it kept from `card`, checked: at least one value,
 * each for a parameter of the card (by its label and part), each a value a
 * `param()` can hold, of a bounded size. A parameter named twice keeps the
 * later value. `Default` is no configuration: the value went to the
 * `param()` call itself.
 */
export function readKept(card: ParamsPart, body: unknown): { ok: true; kept: ParamKeptValue[] } | { ok: false; error: string } {
  const raw = (body && typeof body === 'object' ? (body as Record<string, unknown>).kept : undefined) as unknown;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_OFFERED_PARAMS) {
    return { ok: false, error: '`kept` must list the values kept: [{ label, part?, value, configuration? }].' };
  }
  const kept = new Map<string, ParamKeptValue>();
  for (const [index, entry] of raw.entries()) {
    const item = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    const where = `Value ${index + 1}`;
    if (typeof item.label !== 'string' || (item.part !== undefined && typeof item.part !== 'string')) {
      return { ok: false, error: `${where}: \`label\` (and \`part\`, when given) must be text.` };
    }
    const part = item.part as string | undefined;
    if (!card.params.some((p) => p.label === item.label && p.part === part)) {
      return { ok: false, error: `${where}: the card has no such parameter.` };
    }
    if (!isParamValue(item.value)) {
      return { ok: false, error: `${where}: \`value\` must be text, a number, true or false, or a list of texts and numbers.` };
    }
    if (item.configuration !== undefined && (typeof item.configuration !== 'string' || item.configuration.length > 200)) {
      return { ok: false, error: `${where}: \`configuration\` must be a configuration's name.` };
    }
    const configuration = typeof item.configuration === 'string' && item.configuration !== '' && item.configuration !== 'Default' ? item.configuration : undefined;
    kept.set(keyOf(item.label, part), {
      label: item.label,
      ...(part !== undefined ? { part } : {}),
      value: item.value,
      ...(configuration ? { configuration } : {}),
    });
  }
  return { ok: true, kept: [...kept.values()] };
}

/** `kept` over what the card already says was kept: one entry per parameter, the newest. */
export function mergeKept(before: ParamKeptValue[] | undefined, kept: ParamKeptValue[]): ParamKeptValue[] {
  const merged = new Map((before ?? []).map((k) => [keyOf(k.label, k.part), k]));
  for (const value of kept) {
    merged.set(keyOf(value.label, value.part), value);
  }
  return [...merged.values()];
}

/**
 * The changes the agent is still to be told about, with `kept` from `card`
 * added: where each was written, and one entry per parameter and place —
 * a parameter kept twice before the next message is told once, with its
 * last value.
 *
 * A value kept on a configuration row is in the file on screen, where the
 * row's table is; one kept on Default is in the file that declares the
 * parameter, which a model spread over several files may have elsewhere.
 */
export function addParamChanges(
  pending: ParamChange[] | undefined,
  card: ParamsPart,
  kept: ParamKeptValue[],
  model: ParamCardModel,
  relative: (absPath: string) => string,
): ParamChange[] {
  const changeKey = (c: ParamChange) => JSON.stringify([c.file, c.part ?? null, c.label, c.configuration ?? null]);
  const changes = new Map((pending ?? []).map((c) => [changeKey(c), c]));
  const onScreen = model.file !== null && samePath(model.file, card.absPath);
  for (const value of kept) {
    let file = card.file;
    if (!value.configuration && onScreen) {
      const declaredIn = model.params.find((p) => p.kind !== 'global' && p.label === value.label && p.body === value.part)?.sourceLocation?.filePath;
      if (declaredIn) {
        file = relative(cleanPath(declaredIn));
      }
    }
    const change: ParamChange = { file, ...value };
    changes.set(changeKey(change), change);
  }
  return [...changes.values()];
}

/** `pending` without the changes the agent has now been told about (`told`, as they were when its message was built). */
export function withoutTold(pending: ParamChange[] | undefined, told: ParamChange[]): ParamChange[] {
  const said = new Set(told.map((c) => JSON.stringify(c)));
  return (pending ?? []).filter((c) => !said.has(JSON.stringify(c)));
}

/** The control a declaration is drawn with: its own, or the one its default's type takes (as the Parameters panel reads `auto`). */
function controlOf(p: ModelParam): ParamControl {
  if (p.controlType !== 'auto') {
    return p.controlType;
  }
  return typeof p.defaultValue === 'boolean' ? 'checkbox' : typeof p.defaultValue === 'number' ? 'number' : 'text';
}

function describedParam(p: ModelParam): DescribedParam {
  const control = controlOf(p);
  const ranged = control === 'number' || control === 'slider';
  return {
    label: p.label,
    ...(p.body !== undefined ? { part: p.body } : {}),
    type: control,
    value: p.currentValue,
    ...(JSON.stringify(p.currentValue) !== JSON.stringify(p.defaultValue) ? { default: p.defaultValue } : {}),
    ...(ranged && typeof p.min === 'number' ? { min: p.min } : {}),
    ...(ranged && typeof p.max === 'number' ? { max: p.max } : {}),
    ...(ranged && typeof p.step === 'number' ? { step: p.step } : {}),
    ...(control === 'select' && p.options ? { options: p.options.map((o) => o.value) } : {}),
    ...(control === 'select' && p.multi ? { multi: true as const } : {}),
  };
}

/** A parameter as a refusal lists it: its label, and the part that declares it. */
function describe(p: ModelParam): string {
  return p.body !== undefined ? `${quote(p.label)} (part ${quote(p.body)})` : quote(p.label);
}

function quote(text: string): string {
  return JSON.stringify(text);
}

function keyOf(label: string, part: string | undefined): string {
  return JSON.stringify([part ?? null, label]);
}

function isParamValue(value: unknown): value is ParamCardValue {
  const scalar = (v: unknown, maxChars: number) =>
    (typeof v === 'string' && v.length <= maxChars) || (typeof v === 'number' && Number.isFinite(v));
  if (typeof value === 'boolean' || scalar(value, MAX_KEPT_TEXT_CHARS)) {
    return true;
  }
  return Array.isArray(value) && value.length <= MAX_KEPT_LIST && value.every((v) => scalar(v, 200));
}

/** A file as a render names it, without the live-render prefix a location may carry. */
function cleanPath(filePath: string): string {
  return filePath.replace(/^virtual:live-render:/, '');
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => cleanPath(p).replace(/\\/g, '/');
  return norm(a) === norm(b);
}
