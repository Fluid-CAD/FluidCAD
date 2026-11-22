// The agent's questions to the user (`ask_user`, docs/agent-chat-plan.md §22):
// what a call's input becomes on the card, what the page may answer, and
// what the model is told. A question may be answered by picking geometry in
// the viewport (§27): the picks are scene references (§11), told to the
// model in a reference's own words.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { AskUserInput } from '../../mcp/dist/server.js';
import { sceneReferenceWords } from './instructions.ts';
import { MAX_ANSWER_CHARS, type QuestionAnswer, type QuestionItem, type QuestionPart, type QuestionReply, type SceneReference } from './types.ts';

/** How a question ended. */
export type QuestionOutcome =
  | { kind: 'answered'; answers: QuestionAnswer[] }
  | { kind: 'skipped' }
  | { kind: 'stopped' | 'shutdown' | 'timeout' | 'aborted' };

export const QUESTION_STOPPED_MESSAGE = 'The user stopped the turn before answering.';
export const QUESTION_TIMED_OUT_MESSAGE =
  'The user did not answer within an hour. Do not ask again: end your turn and say what you need to know.';
export const QUESTION_SKIPPED_NOTE =
  'The user skipped without answering. Decide yourself, carry on, and state the assumption you made.';

/**
 * The questions of a call as the card shows them, or what is wrong with
 * them. The schema already bounds counts and lengths; this trims, drops
 * empty descriptions, refuses options one answer could not tell apart,
 * refuses a drawing the card could not show, and refuses a question that
 * offers options and asks for a pick at once.
 */
export function readQuestions(input: AskUserInput): { ok: true; questions: QuestionItem[] } | { ok: false; error: string } {
  const questions: QuestionItem[] = [];
  for (const q of input.questions) {
    const item: QuestionItem = { question: q.question.trim() };
    if (q.svg !== undefined) {
      const drawing = readSvg(q.svg);
      if (drawing.ok === false) {
        return { ok: false, error: `The \`svg\` of "${item.question}" ${drawing.error}` };
      }
      item.svg = drawing.svg;
    }
    if (q.options && q.options.length > 0) {
      const seen = new Set<string>();
      item.options = [];
      for (const option of q.options) {
        const label = option.label.trim();
        if (seen.has(label)) {
          return { ok: false, error: `Two options of "${item.question}" share the label "${label}". Give every option its own label.` };
        }
        seen.add(label);
        const description = option.description?.trim();
        let svg: string | undefined;
        if (option.svg !== undefined) {
          const drawing = readSvg(option.svg);
          if (drawing.ok === false) {
            return { ok: false, error: `The \`svg\` of the option "${label}" ${drawing.error}` };
          }
          svg = drawing.svg;
        }
        item.options.push({ label, ...(description ? { description } : {}), ...(svg ? { svg } : {}) });
      }
      if (q.multiSelect === true) {
        item.multiSelect = true;
      }
    }
    if (q.pick !== undefined) {
      if (item.options) {
        return {
          ok: false,
          error: `"${item.question}" has both \`options\` and \`pick\`. A question is answered by choosing an option or by picking geometry in the viewport, not both: give one of them (or ask two questions).`,
        };
      }
      item.pick = { kind: q.pick.kind, ...(q.pick.multiple === true ? { multiple: true } : {}) };
    }
    questions.push(item);
  }
  return { ok: true, questions };
}

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

/**
 * A drawing as the card can show it, or what is wrong with it (the rest of a
 * sentence that starts with whose drawing it is).
 *
 * The card shows it as an image, which needs one `<svg>` element that says
 * its namespace (added here when the model left it out) and scales only with
 * a `viewBox`. This is no sanitizer and the markup stays untrusted: what
 * keeps a script or a remote reference in it from doing anything is that the
 * page only ever shows it through an `<img>`.
 */
export function readSvg(raw: string): { ok: true; svg: string } | { ok: false; error: string } {
  // An XML declaration ahead of the element is harmless: drop it.
  const svg = raw.trim().replace(/^<\?xml[^>]*\?>\s*/i, '');
  const open = openingTag(svg);
  if (!/^<svg[\s>]/.test(svg) || !/<\/svg\s*>$/.test(svg) || open === null) {
    return { ok: false, error: 'must be one `<svg …>…</svg>` element and nothing else (no code fence, no text around it).' };
  }
  if (!/\sviewBox\s*=/.test(open)) {
    return { ok: false, error: 'needs a `viewBox` (for example `viewBox="0 0 120 90"`), or it cannot be scaled to the card.' };
  }
  if (/\sxmlns\s*=/.test(open)) {
    return { ok: true, svg };
  }
  return { ok: true, svg: `<svg xmlns="${SVG_NAMESPACE}"${svg.slice('<svg'.length)}` };
}

/** The first tag of `markup`, up to its `>`; a `>` inside a quoted attribute is not the end. Null when it never closes. */
function openingTag(markup: string): string | null {
  let quote = '';
  for (let i = 0; i < markup.length; i++) {
    const char = markup[i];
    if (quote) {
      if (char === quote) {
        quote = '';
      }
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '>') {
      return markup.slice(0, i + 1);
    }
  }
  return null;
}

/** Picks one answer may carry: one colour each, as a message's references (§11.1). */
export const MAX_PICKS = 8;
/** The longest selector, name or line a pick may carry. */
const MAX_PICK_TEXT = 4000;
/** Entities one pick may summarize. */
const MAX_PICK_GEOMETRY = 500;

/**
 * A scene reference the page sent as a pick, copied field by field (nothing
 * else it sent rides along), or null when it is not one. The page builds it
 * from `api/resolve-selection` exactly as it builds a message's references.
 */
export function readPick(raw: unknown): SceneReference | null {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const selector = (value.selector && typeof value.selector === 'object' ? value.selector : {}) as Record<string, any>;
  const text = (v: unknown): v is string => typeof v === 'string' && v.length <= MAX_PICK_TEXT;
  const texts = (v: unknown, max: number): v is string[] => Array.isArray(v) && v.length <= max && v.every(text);
  if (
    !Number.isInteger(value.n) || value.n < 1 || value.n > MAX_PICKS ||
    !text(value.color?.name) || !text(value.color?.hex) ||
    !['face', 'edge', 'mixed'].includes(value.kind) ||
    !Number.isInteger(value.count) || value.count < 1 ||
    !text(value.file) || !text(value.unit) ||
    !text(selector.source) || selector.source.trim() === '' ||
    !texts(selector.imports, 16) || !texts(selector.alternatives, 8) ||
    !Array.isArray(selector.producers) || selector.producers.length > 32 ||
    !Array.isArray(value.geometry) || value.geometry.length > MAX_PICK_GEOMETRY
  ) {
    return null;
  }
  const producers: SceneReference['selector']['producers'] = [];
  for (const p of selector.producers as any[]) {
    if (!p || !text(p.variable) || !text(p.feature) || !text(p.featureType) || !(p.line === null || Number.isInteger(p.line))) {
      return null;
    }
    producers.push({ variable: p.variable, feature: p.feature, featureType: p.featureType, line: p.line, bound: p.bound === true });
  }
  return {
    n: value.n,
    color: { name: value.color.name, hex: value.color.hex },
    kind: value.kind,
    count: value.count,
    file: value.file,
    selector: { source: selector.source, producers, imports: [...selector.imports], alternatives: [...selector.alternatives] },
    geometry: value.geometry.filter((g: unknown) => !!g && typeof g === 'object'),
    unit: value.unit,
  };
}

/**
 * The page's answer to `questions`, checked: one answer per question, picks
 * that are options of that question (one unless it is `multiSelect`), text
 * of a bounded length, geometry only for a question that asked for a pick
 * (of the kind it takes, one face or edge unless it takes several), and at
 * least one question answered (leaving all of them open is a skip).
 */
export function readQuestionReply(questions: QuestionItem[], body: unknown): { ok: true; reply: QuestionReply } | { ok: false; error: string } {
  const record = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  if (record.skip === true) {
    return { ok: true, reply: { skip: true } };
  }
  const raw = record.answers;
  if (!Array.isArray(raw) || raw.length !== questions.length) {
    return { ok: false, error: '`answers` must have one answer per question, or send `{ "skip": true }`.' };
  }
  const answers: QuestionAnswer[] = [];
  for (let i = 0; i < questions.length; i++) {
    const question = questions[i];
    const answer = (raw[i] && typeof raw[i] === 'object' ? raw[i] : {}) as Record<string, unknown>;
    const picked = answer.selected ?? [];
    if (!Array.isArray(picked) || picked.some((label) => typeof label !== 'string')) {
      return { ok: false, error: `Answer ${i + 1}: \`selected\` must be a list of option labels.` };
    }
    const labels = new Set((question.options ?? []).map((o) => o.label));
    const selected = [...new Set(picked as string[])];
    if (selected.some((label) => !labels.has(label))) {
      return { ok: false, error: `Answer ${i + 1}: \`selected\` names an option the question does not offer.` };
    }
    if (selected.length > 1 && !question.multiSelect) {
      return { ok: false, error: `Answer ${i + 1}: the question takes one option.` };
    }
    if (answer.text !== undefined && typeof answer.text !== 'string') {
      return { ok: false, error: `Answer ${i + 1}: \`text\` must be text.` };
    }
    const text = typeof answer.text === 'string' ? answer.text.trim() : '';
    if (text.length > MAX_ANSWER_CHARS) {
      return { ok: false, error: `Answer ${i + 1}: \`text\` is longer than ${MAX_ANSWER_CHARS} characters.` };
    }
    const picks: SceneReference[] = [];
    if (answer.picks !== undefined) {
      if (!Array.isArray(answer.picks) || answer.picks.length > MAX_PICKS) {
        return { ok: false, error: `Answer ${i + 1}: \`picks\` must be at most ${MAX_PICKS} scene references.` };
      }
      if (answer.picks.length > 0 && !question.pick) {
        return { ok: false, error: `Answer ${i + 1}: the question does not take picked geometry.` };
      }
      for (const raw of answer.picks) {
        const pick = readPick(raw);
        if (!pick) {
          return { ok: false, error: `Answer ${i + 1}: each of \`picks\` must be a scene reference.` };
        }
        if (question.pick!.kind !== 'any' && pick.kind !== question.pick!.kind) {
          return { ok: false, error: `Answer ${i + 1}: the question takes ${question.pick!.kind}s only.` };
        }
        picks.push(pick);
      }
      if (!question.pick?.multiple && (picks.length > 1 || (picks[0]?.count ?? 1) > 1)) {
        return { ok: false, error: `Answer ${i + 1}: the question takes one ${question.pick!.kind === 'any' ? 'face or edge' : question.pick!.kind}.` };
      }
      if (new Set(picks.map((p) => p.n)).size !== picks.length) {
        return { ok: false, error: `Answer ${i + 1}: two of \`picks\` share a number.` };
      }
    }
    answers.push({ selected, ...(text ? { text } : {}), ...(picks.length > 0 ? { picks } : {}) });
  }
  if (!answers.some(isAnswered)) {
    return { ok: false, error: 'Answer at least one question, or send `{ "skip": true }`.' };
  }
  return { ok: true, reply: { answers } };
}

export function isAnswered(answer: QuestionAnswer | undefined): boolean {
  return !!answer && (answer.selected.length > 0 || !!answer.text || (answer.picks?.length ?? 0) > 0);
}

/**
 * A pick as the model reads it: the fields of a `<ref>` of
 * `<scene_references>` (§11.3), in the same words, so what the preamble says
 * of a reference holds for it. Empty fields are left out.
 */
export function pickForModel(pick: SceneReference): Record<string, unknown> {
  const words = sceneReferenceWords(pick);
  return {
    n: pick.n,
    color: pick.color.name,
    kind: pick.kind,
    count: pick.count,
    ...(pick.file ? { file: pick.file } : {}),
    unit: pick.unit,
    selector: words.selector,
    ...(words.imports.length > 0 ? { imports: words.imports } : {}),
    ...(words.producers.length > 0 ? { producers: words.producers } : {}),
    ...(words.alternatives.length > 0 ? { alternatives: words.alternatives } : {}),
    ...(words.geometry ? { geometry: words.geometry } : {}),
  };
}

/** What the card becomes when the question ends. */
export function questionPatch(outcome: QuestionOutcome): Partial<QuestionPart> {
  switch (outcome.kind) {
    case 'answered':
      return { state: 'answered', answers: outcome.answers };
    case 'skipped':
      return { state: 'skipped' };
    case 'stopped':
      return { state: 'unanswered', reason: 'Stopped before you answered.' };
    case 'shutdown':
      return { state: 'unanswered', reason: 'The app closed before you answered.' };
    case 'timeout':
      return { state: 'unanswered', reason: 'Not answered within an hour.' };
    case 'aborted':
      return { state: 'unanswered', reason: 'Cancelled.' };
  }
}

/** What `ask_user` returns to the model. `cancelledMessage`: the gate's text for a call the client gave up on. */
export function questionResult(questions: QuestionItem[], outcome: QuestionOutcome, cancelledMessage: string): CallToolResult {
  switch (outcome.kind) {
    case 'answered':
      return json({
        answers: questions.map((q, i) => {
          const answer = outcome.answers[i];
          if (!isAnswered(answer)) {
            return { question: q.question, skipped: true };
          }
          return {
            question: q.question,
            ...(answer.selected.length > 0 ? { selected: answer.selected } : {}),
            ...(answer.picks && answer.picks.length > 0 ? { picks: answer.picks.map(pickForModel) } : {}),
            ...(answer.text ? { text: answer.text } : {}),
          };
        }),
      });
    case 'skipped':
      return json({ skipped: true, note: QUESTION_SKIPPED_NOTE });
    case 'stopped':
    case 'shutdown':
      return failure(QUESTION_STOPPED_MESSAGE);
    case 'timeout':
      return failure(QUESTION_TIMED_OUT_MESSAGE);
    case 'aborted':
      return failure(cancelledMessage);
  }
}

function json(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

export function failure(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}
