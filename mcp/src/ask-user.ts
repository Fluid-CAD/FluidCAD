// `ask_user`: a question to the person the agent works for.
//
// Only a host with someone to ask offers it (`BuildServerOptions.askUser`:
// the in-app chat, which shows the question as a card and waits for the
// answer). The standalone server has nobody on the other end, so it does not
// register the tool. It is no tool of TOOL_CLASSES and does not pass through
// the tool gate: it changes nothing and its whole effect is the host's.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

export const ASK_USER_TOOL = 'ask_user';

/** Questions one call may carry. */
export const MAX_QUESTIONS = 4;
/** Options one question may offer. */
export const MAX_OPTIONS = 6;
/** The longest drawing (`svg`) a question or an option may carry, in characters. */
export const MAX_SVG_CHARS = 4000;

export type AskUserOption = {
  label: string;
  description?: string;
  /** A small drawing of the choice, as SVG markup. */
  svg?: string;
};

export type AskUserQuestion = {
  question: string;
  /** A figure the question refers to, as SVG markup. */
  svg?: string;
  /** Absent: the user answers in their own words. */
  options?: AskUserOption[];
  /** Several options may be picked. */
  multiSelect?: boolean;
};

export type AskUserInput = { questions: AskUserQuestion[] };

/**
 * Asks and waits. Resolves with what the tool returns: the answers, that the
 * user skipped, or a tool error when nobody answered (the turn was stopped,
 * the wait timed out). `signal` aborts when the client cancels the call.
 */
export type McpAskUser = (input: AskUserInput, signal: AbortSignal) => Promise<CallToolResult>;

export const ASK_USER_TITLE = 'Ask the user a question';

export const ASK_USER_DESCRIPTION =
  'Asks the user one to four questions and waits for their answers. They see them as one card in the chat, pick from the options you give or write their own answer, and may skip. ' +
  'Use it when a choice is the user\'s to make and a wrong guess would cost real rework: a dimension or count the request leaves open, which of several readings of the request they mean, a design decision with no sensible default. ' +
  'Do not use it for anything the tools can tell you (the model, the files, the docs), to ask permission to proceed or to confirm a plan (changes already wait for the user\'s approval), or when a sensible default exists: take the default and say so. ' +
  'Ask everything you need in one call rather than one question per call, and ask before you start the work the answers decide, not after. ' +
  'Give `options` whenever the answers can be listed: two to six short, concrete, mutually exclusive choices (set `multiSelect` when several may apply), the one you recommend first. Never add an "Other" option: the user can always write their own answer. Leave `options` out for an open question (a name, a free dimension). ' +
  'Add `svg` when a picture tells the choices apart faster than words do: a shape, a cross-section, a layout, which side or which direction. Give every option of the question a drawing or none; a question\'s own `svg` is a figure the question refers to (the dimension it asks for, labelled). ' +
  'A drawing is a small line sketch, not decoration: one `<svg viewBox="0 0 120 90">` element (the same viewBox for all options of a question), a few shapes, dark strokes about 2 wide on a transparent background (it is shown on a light tile, and adapted to a dark theme for you), a second colour only to mark what differs, text only for a label the drawing needs (10 or larger). No scripts, no animation, no external images or fonts. The label and description must still say everything: the drawing may fail to show. ' +
  'Returns `{ answers: [{ question, selected?, text?, skipped? }] }`, one per question in order: `selected` are the labels picked, `text` is what the user wrote (it adds to or replaces the options), `skipped: true` means they left that one open. `{ skipped: true }` alone means they skipped every question. ' +
  'A skipped question is yours to decide: choose sensibly, carry on, and state the assumption you made. An error means nobody answered (the turn was stopped, or an hour passed): do not ask again in this turn.';

export const askUserInputSchema = {
  questions: z
    .array(
      z.object({
        question: z.string().trim().min(1).max(600).describe('The question, complete and specific, ending in a question mark.'),
        svg: z.string().trim().min(1).max(MAX_SVG_CHARS).optional().describe('A figure the question refers to: one `<svg viewBox="…">` element. Omit when the words are enough.'),
        options: z
          .array(
            z.object({
              label: z.string().trim().min(1).max(80).describe('The choice in a few words; this is what `selected` returns.'),
              description: z.string().trim().max(240).optional().describe('What choosing it means or implies, in a sentence.'),
              svg: z.string().trim().min(1).max(MAX_SVG_CHARS).optional().describe('A small drawing of this choice: one `<svg viewBox="…">` element.'),
            }),
          )
          .min(2)
          .max(MAX_OPTIONS)
          .optional()
          .describe('The choices to pick from. Omit for an open question the user answers in their own words.'),
        multiSelect: z.boolean().optional().describe('Whether several options may be picked (default: one).'),
      }),
    )
    .min(1)
    .max(MAX_QUESTIONS)
    .describe('The questions, in the order to show them.'),
};
