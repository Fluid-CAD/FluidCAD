// The agent's questions to the user (`ask_user`, docs/agent-chat-plan.md §22):
// what a call's input becomes on the card, what the page may answer, and
// what the model is told.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { AskUserInput } from '../../mcp/dist/server.js';
import { MAX_ANSWER_CHARS, type QuestionAnswer, type QuestionItem, type QuestionPart, type QuestionReply } from './types.ts';

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
 * empty descriptions and refuses options one answer could not tell apart.
 */
export function readQuestions(input: AskUserInput): { ok: true; questions: QuestionItem[] } | { ok: false; error: string } {
  const questions: QuestionItem[] = [];
  for (const q of input.questions) {
    const item: QuestionItem = { question: q.question.trim() };
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
        item.options.push({ label, ...(description ? { description } : {}) });
      }
      if (q.multiSelect === true) {
        item.multiSelect = true;
      }
    }
    questions.push(item);
  }
  return { ok: true, questions };
}

/**
 * The page's answer to `questions`, checked: one answer per question, picks
 * that are options of that question (one unless it is `multiSelect`), text
 * of a bounded length, and at least one question answered (leaving all of
 * them open is a skip).
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
    answers.push({ selected, ...(text ? { text } : {}) });
  }
  if (!answers.some(isAnswered)) {
    return { ok: false, error: 'Answer at least one question, or send `{ "skip": true }`.' };
  }
  return { ok: true, reply: { answers } };
}

export function isAnswered(answer: QuestionAnswer | undefined): boolean {
  return !!answer && (answer.selected.length > 0 || !!answer.text);
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
