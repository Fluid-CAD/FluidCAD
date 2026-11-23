// `offer_params`: the model's parameters as live controls in front of the
// person the agent works for.
//
// Only a host with a chat offers it (`BuildServerOptions.offerParams`: the
// in-app chat, which shows the parameters as a card of controls). The
// standalone server has no chat to put a card in, so it does not register
// the tool. Like `ask_user` it is no tool of TOOL_CLASSES and does not pass
// through the tool gate: it writes nothing, and what the user does with the
// card is their own action. Unlike `ask_user` it does not wait.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

export const OFFER_PARAMS_TOOL = 'offer_params';

/** Parameters one card may show. */
export const MAX_OFFERED_PARAMS = 12;
/** The longest note a card carries. */
export const MAX_PARAMS_NOTE_CHARS = 200;

/** One parameter to show: its `param()` label, and the part that declares it when the label alone is ambiguous. */
export type OfferedParam = { label: string; part?: string };

export type OfferParamsInput = {
  /** Absent: every parameter of the model on screen. */
  params?: OfferedParam[];
  /** One line shown on the card. */
  note?: string;
};

/**
 * Puts the card in the chat and resolves at once with what the tool
 * returns: what the card shows, or a tool error the model can correct (a
 * label the model on screen does not declare). `signal` aborts when the
 * client cancels the call.
 */
export type McpOfferParams = (input: OfferParamsInput, signal: AbortSignal) => Promise<CallToolResult>;

export const OFFER_PARAMS_TITLE = 'Offer parameters to the user as live controls';

/**
 * The tool's description. The in-app preamble (`agent/src/instructions.ts`)
 * and the skill (`skills/fluidcad/SKILL.md`, "`offer_params`: the model's
 * parameters as live controls in the chat") say the same: when to call it
 * and when not to.
 */
export const OFFER_PARAMS_DESCRIPTION = [
  'Puts parameters of the model on screen into the chat as a card of live controls (a slider, a number field, a select, a switch), so ' +
    'the user tunes a dimension by dragging instead of asking you again. It returns at once and does not wait for the user. A control ' +
    'changes the model on screen only, as a session value: nothing is written. The user may then Keep the values, which writes them ' +
    'into the source as the parameters\' defaults, or Reset them; after they keep any, their next message carries `<param_changes>` ' +
    'with the new values.',
  'Do NOT call it by default: most turns end without a card. Call it only when (1) a new or reworked model is finished and rendered ' +
    'and has a few dimensions the user is plausibly going to tune — they said "roughly", gave a range, or are exploring a design — or ' +
    '(2) the user asks to play with the sizes. Do not call it after every edit; when the user gave exact values and asked for nothing ' +
    'else; for a model with no dimension worth tuning; again for parameters this conversation already offered, unless they changed; ' +
    'or in place of ask_user for a question that blocks the work (the card does not wait for an answer). Never add a param() only to ' +
    'have something to offer.',
  'Input: offer the few parameters that matter, not all of them. `params` names them by the label of their param() call, with `part` ' +
    '(the name of the part() or assembly()) when two parts declare the same label; without `params` the card shows every parameter ' +
    `of the model, which is refused beyond ${MAX_OFFERED_PARAMS}. Only parameters the model on screen declares in a part() or assembly() body can be ` +
    'offered, not project parameters (`*.params.js`); a label that does not exist is refused with the ones that do. A number declared ' +
    'as a slider with its range (`param("Width", 40, "slider", { min: 20, max: 80, step: 1 })`) gets a slider. `note` is one line ' +
    'shown on the card, as plain text.',
  'Result: `{ file, params: [{ label, part?, type, value, min?, max?, step?, options? }] }` — what the card shows. A call builds ' +
    'nothing and costs no render.',
].join('\n\n');

export const offerParamsInputSchema = {
  params: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(200).describe('The label of the param() call, exactly as declared.'),
        part: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .optional()
          .describe('The name of the part() or assembly() that declares it. Needed only when two of them declare the label.'),
      }),
    )
    .min(1)
    .max(MAX_OFFERED_PARAMS)
    .optional()
    .describe('The parameters to show, in the order to show them. Omit to show every parameter of the model on screen.'),
  note: z.string().trim().max(MAX_PARAMS_NOTE_CHARS).optional().describe('One line shown on the card: what to try, or what a value trades off.'),
};
