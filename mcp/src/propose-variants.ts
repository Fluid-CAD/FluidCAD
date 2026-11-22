// `propose_variants`: two candidate versions of one model file, built and
// shown to the user side by side; the one they pick is written.
//
// Only a host with a chat offers it (`BuildServerOptions.proposeVariants`:
// the in-app chat, which builds the candidates, shows them as a card of 3D
// tiles and waits for the pick). The standalone server has nobody to show
// them to, so it does not register the tool. Like `ask_user` it is no tool
// of TOOL_CLASSES and does not pass through the tool gate: the user's pick
// is the approval of the write, and the host that takes the pick is the one
// that would gate it.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { RangeEdit } from './tools/source.ts';

export const PROPOSE_VARIANTS_TOOL = 'propose_variants';

/** How many variants one call carries: exactly this many. */
export const VARIANT_COUNT = 2;

export type ProposedVariant = {
  label: string;
  description?: string;
  /** The whole text of the file in this variant, as `write_file` takes it. */
  content?: string;
  /** Or the variant as replacements in the file on disk, each as `edit_range` takes one. */
  edits?: RangeEdit[];
};

export type ProposeVariantsInput = {
  /** The one model file every variant is a version of. */
  path: string;
  /** What the user is choosing, in a line. */
  question?: string;
  variants: ProposedVariant[];
};

/**
 * Builds the variants, shows them and waits. Resolves with what the tool
 * returns: the pick and the render of its write, that the user skipped,
 * their own words, or a tool error (a candidate a write would refuse, both
 * failing to build, nobody answering). `signal` aborts when the client
 * cancels the call.
 */
export type McpProposeVariants = (input: ProposeVariantsInput, signal: AbortSignal) => Promise<CallToolResult>;

export const PROPOSE_VARIANTS_TITLE = 'Show the user two built variants of a model to choose from';

/**
 * The tool's description. The in-app preamble (`agent/src/instructions.ts`)
 * and the skill (`skills/fluidcad/SKILL.md`, "`propose_variants`: two built
 * alternatives for the user to choose from") say the same: when to call it,
 * when not to, and what a call costs.
 */
export const PROPOSE_VARIANTS_DESCRIPTION = [
  'Builds two candidate versions of one model file, shows them to the user side by side as 3D tiles in the chat (picture, body count, ' +
    'overall size, volume) and waits for the user to pick one. The picked variant is written to `path` and rendered as part of this ' +
    'turn: the pick is the user\'s approval, so no approval is asked again and you do not write it yourself.',
  'Do NOT call it by default: an ordinary change is one write. Call it only when (1) the user asks to see options or alternatives, or ' +
    '(2) the request leaves the form or the layout genuinely open and the two alternatives look different: a rib versus a gusset, two ' +
    'hole layouts, two handle shapes. Do not call it for a request with one sensible reading; for variants that differ only by a ' +
    'number the user could simply state (a dimension is a question for ask_user or a param(), not variants); to confirm a plan; with ' +
    'a second option added only to fill the card, one you would not build yourself; or after every change.',
  'Cost: two full builds from scratch, one after the other, and the engine does nothing else while each runs — the app waits.',
  'Input: `path` is the model file (`.fluid.js`, `.part.js`, `.assembly.js`); `question` says what is being chosen, in a line; ' +
    '`variants` is exactly two, each with a short `label` (unique), an optional one-sentence `description` of what differs, and the ' +
    'candidate as `content` (the whole file, as write_file takes it) or `edits` (replacements in the file on disk, each as edit_range ' +
    'takes one, every range addressed in the file as it is now) — one of the two, never both. Each candidate passes write_file\'s ' +
    'guards first (codes `missing-imports`, `part-rules`, `unit-statement`, `dirty-buffer`): a refused one is an error naming the ' +
    'variant, and nothing is built or shown. Labels and descriptions are shown as plain text.',
  'Result: `{ picked: <label>, render }` — the variant was written, and `render` is what write_file reports for it (check ' +
    '`render.state`, fix a `build-error` as after any write). `{ skipped: true, note }`: the user chose neither; decide yourself, ' +
    'write your choice with write_file or edit_range, and say what you assumed. `{ answer: <text> }`: the user wrote their own answer ' +
    'instead (for example "neither — make the base thicker"); nothing was written, so act on it. A variant that does not build is ' +
    'shown as failed and cannot be picked; an error is returned without asking when neither builds (it lists why), when the file ' +
    'changed while the user was choosing, or when nobody answered (the turn was stopped, or an hour passed): do not call it again in ' +
    'this turn for the same choice.',
].join('\n\n');

const positionSchema = z
  .object({
    line: z.number().int().nonnegative().describe('Zero-based line number.'),
    column: z.number().int().nonnegative().describe('Zero-based UTF-16 column.'),
  })
  .describe('Source position (LSP-style, 0-based line and 0-based UTF-16 column).');

export const proposeVariantsInputSchema = {
  path: z
    .string()
    .min(1)
    .describe('The model file both variants are versions of (`.fluid.js`, `.part.js`, `.assembly.js`), relative to the workspace root or absolute inside it.'),
  question: z.string().trim().max(300).optional().describe('What the user is choosing, in a line: "Which stiffener?".'),
  variants: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(60).describe('The variant in a few words ("Rib", "Gusset"); this is what `picked` returns.'),
        description: z.string().trim().max(240).optional().describe('What differs in this variant, in a sentence.'),
        content: z.string().optional().describe('The whole text of the file in this variant, as write_file takes it. Not together with `edits`.'),
        edits: z
          .array(
            z.object({
              start: positionSchema,
              end: positionSchema,
              newText: z.string().describe('Replacement text (may be empty to delete the range).'),
            }),
          )
          .min(1)
          .max(50)
          .optional()
          .describe('The variant as replacements in the file on disk, each `[start, end)` range as edit_range takes one. Every range is addressed in the file as it is now; ranges must not overlap. Not together with `content`.'),
      }),
    )
    .min(VARIANT_COUNT)
    .max(VARIANT_COUNT)
    .describe('Exactly two variants, in the order to show them, the one you recommend first.'),
};
