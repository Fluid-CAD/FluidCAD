// `show_user`: the agent points at geometry of the model on screen.
//
// Only a host with a chat offers it (`BuildServerOptions.showUser`: the
// in-app chat, which highlights the items in the live viewport and lists
// them on a card). The standalone server has no viewport of its own to point
// in and no chat to put the chips in, so it does not register the tool. Like
// `ask_user` and `offer_params` it is no tool of TOOL_CLASSES and does not
// pass through the tool gate: it changes no file. Like `offer_params` it
// does not wait.
//
// What an item points at is resolved here, the way `resolve_selection`
// resolves a selector, so the host is handed items that are known to
// resolve and how the page can resolve each of them again.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { HttpError } from './client.ts';
import { resolveClient, type SelectionScopeInput, type WorkspaceArg } from './tools/inspection.ts';

export const SHOW_USER_TOOL = 'show_user';

/** Items one call may show: one colour each, as the user's own references (eight). */
export const MAX_SHOW_ITEMS = 8;
/** The longest label an item carries. */
export const MAX_SHOW_LABEL_CHARS = 80;
/** The longest note a card carries. */
export const MAX_SHOW_NOTE_CHARS = 240;
/** The longest selector an item carries (the engine's own limit). */
const MAX_EXPRESSION_CHARS = 4000;

/**
 * The colours of the chips, by number, as the model is told them. The page
 * draws item `n` in the colour of that name in its reference palette
 * (`ui/src/ui/chat/reference-colors.ts`); a test holds the two in step.
 */
export const SHOW_USER_COLORS = ['red', 'blue', 'green', 'magenta', 'cyan', 'yellow', 'orange', 'purple'] as const;

/** One face or edge, addressed as `measure` and `hit_test` address entities. Valid for the render it was read from. */
export type ShowRef = { shapeId: string; kind: 'face' | 'edge'; index: number };

/** One thing to point at: a label, and a selector or a face/edge ref (exactly one). */
export type ShowUserItem = {
  label: string;
  expression?: string;
  /** Where `expression` is evaluated, as `resolve_selection` takes it. */
  scope?: SelectionScopeInput;
  ref?: ShowRef;
};

export type ShowUserInput = { items: ShowUserItem[]; note?: string };

/**
 * Highlights the items and puts their card in the chat, and resolves at
 * once with what the tool returns: each item's number, colour and counts,
 * or a tool error the model can correct (an item that resolves to nothing).
 * `signal` aborts when the client cancels the call.
 */
export type McpShowUser = (input: ShowUserInput, signal: AbortSignal) => Promise<CallToolResult>;

/**
 * What a page resolves again to draw an item (`POST api/resolve-selection`):
 * a selector, which follows the geometry through later renders, or a face or
 * edge of the render it was shown in, which a later render may not hold.
 */
export type ShowTarget = { expression: string; scope?: SelectionScopeInput } | { pick: ShowRef };

/** An item that resolved: what it points at, and how many faces and edges that is now. */
export type ResolvedShowItem = { label: string; target: ShowTarget; faces: number; edges: number };

export const SHOW_USER_TITLE = 'Point at geometry of the model for the user';

/**
 * The tool's description. The in-app preamble (`agent/src/instructions.ts`)
 * and the skill (`skills/fluidcad/SKILL.md`, "`show_user`: pointing at
 * geometry in the user's viewport") say the same: when to call it and when
 * not to.
 */
export const SHOW_USER_DESCRIPTION = [
  'Points at geometry of the model on screen. Each item is highlighted in the user\'s live viewport in its own colour and listed on a ' +
    'card in the chat as a numbered chip with your label (`[1]` red, `[2]` blue, …); write `[1]`, `[2]` in your text to refer to them, ' +
    'as the user\'s own scene references read. It returns at once and does not wait for the user. It changes no file and costs no ' +
    'render. A newer call replaces the highlight of an older one, and the user can clear it.',
  'Do NOT call it by default: the user already sees the viewport. Call it only when words would not locate the geometry reliably: ' +
    '(1) a problem you found on a particular face or edge; (2) the candidates of a question you are asking ("this face [1] or that one ' +
    '[2]?"); (3) a proposal that touches particular geometry, before you make the change. Do not call it after every edit; to ' +
    'illustrate what you just built; for a whole body, or everything a feature made; or again in the same turn unless what you point ' +
    'at changed. Show the few items your text refers to, not everything near them.',
  `Input: \`items\`, 1 to ${MAX_SHOW_ITEMS}, each with a \`label\` and exactly one of \`expression\` or \`ref\`. \`expression\` is a selector as ` +
    'resolve_selection takes one (filter syntax, `$obj["<id>"]` accessors, an optional `scope`); every face and edge it matches is ' +
    'highlighted. `ref` is one face or edge, `{ shapeId, kind, index }`, from hit_test, resolve_selection or the property tools. ' +
    'Prefer an expression: it keeps pointing at the geometry when the model re-renders, while a `ref` may not survive a render (the ' +
    'card then shows the item as stale instead of pointing at something else). `label` names the item for the user in a few words ' +
    '("mounting face", "wall thinner than 1 mm"); `note` is one line shown on the card. Both are shown as plain text.',
  'Result: `{ shown: [{ n, color, label, faces, edges }] }` — each item\'s chip number and colour, and how many faces and edges it ' +
    'resolved to. An item that resolves to nothing, or only to vertices, is an error naming the item, and nothing is shown: correct ' +
    'it and call again.',
].join('\n\n');

export const showUserInputSchema = {
  items: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(MAX_SHOW_LABEL_CHARS).describe('What this is, for the user, in a few words. Plain text.'),
        expression: z
          .string()
          .trim()
          .min(1)
          .max(MAX_EXPRESSION_CHARS)
          .optional()
          .describe('A selector, as resolve_selection takes one: face().onPlane("xy", 10), $obj["<id>"].endEdges(). Every face and edge it matches is highlighted.'),
        scope: z
          .union([
            z.object({ sceneObjectId: z.string().min(1) }),
            z.object({ part: z.string().min(1) }),
            z.object({ instanceId: z.string().min(1) }),
          ])
          .optional()
          .describe('Where `expression` is evaluated, as in resolve_selection. Omit for the whole scene.'),
        ref: z
          .object({
            shapeId: z.string().min(1).describe('Shape id from list_shapes / get_scene_summary / hit_test.'),
            kind: z.enum(['face', 'edge']),
            index: z.number().int().nonnegative().describe('The face or edge index in that shape.'),
          })
          .optional()
          .describe('One face or edge of the current render, instead of an expression.'),
      }),
    )
    .min(1)
    .max(MAX_SHOW_ITEMS)
    .describe('What to point at, in the order of the chips: item 1 is `[1]`.'),
  note: z.string().trim().max(MAX_SHOW_NOTE_CHARS).optional().describe('One line shown on the card: what the items are about.'),
};

type EngineMatch = { shapeId: string; kind: 'face' | 'edge' | 'vertex'; index: number; instanceId?: string };
type EngineAnswer = {
  ok: true;
  matches: EngineMatch[];
  scope?: { kind: 'root' } | { kind: 'part'; part: string } | { kind: 'sceneObject'; sceneObjectId: string } | { kind: 'instance'; instanceId: string };
  synthesized?: { ok: true; expression: string } | { ok: false };
};

/**
 * Resolves every item against the engine's current scene, the way
 * `resolve_selection` does, or says what is wrong with the first that does
 * not resolve (naming it by number and label). A `ref` whose synthesized
 * selector is verified to resolve back to exactly that face or edge is
 * handed on as the selector, so the item survives a re-render.
 */
export async function resolveShowItems(
  input: ShowUserInput,
  target: WorkspaceArg,
): Promise<{ ok: true; items: ResolvedShowItem[] } | { ok: false; error: string }> {
  const resolved = resolveClient(target);
  if (resolved.ok === false) {
    return { ok: false, error: resolved.message };
  }
  const { client } = resolved.data;
  const post = async (body: unknown): Promise<EngineAnswer | { ok: false; error: string }> => {
    try {
      const answer = await client.postJson<any>('/api/resolve-selection', body);
      return answer && answer.ok === true && Array.isArray(answer.matches) ? answer : { ok: false, error: 'the engine gave no answer for it.' };
    } catch (e) {
      return { ok: false, error: engineError(e) };
    }
  };
  try {
    const items: ResolvedShowItem[] = [];
    for (let i = 0; i < input.items.length; i++) {
      const item = input.items[i];
      const name = `Item ${i + 1} ("${item.label}")`;
      if ((item.expression === undefined) === (item.ref === undefined)) {
        return { ok: false, error: `${name}: give exactly one of \`expression\` (a selector) or \`ref\` ({ shapeId, kind, index }).` };
      }
      if (item.ref !== undefined && item.scope !== undefined) {
        return { ok: false, error: `${name}: \`scope\` goes with \`expression\`; a \`ref\` needs none.` };
      }
      const answer = await post(
        item.expression !== undefined
          ? { expression: item.expression, ...(item.scope ? { scope: item.scope } : {}) }
          : { picks: [item.ref] },
      );
      if (answer.ok === false) {
        return { ok: false, error: `${name}: ${answer.error} Nothing was shown.` };
      }
      const faces = answer.matches.filter((m) => m.kind === 'face').length;
      const edges = answer.matches.filter((m) => m.kind === 'edge').length;
      if (faces + edges === 0) {
        const why = answer.matches.length > 0
          ? 'it resolves to vertices only; point at faces or edges.'
          : 'the expression matches nothing in the current model.';
        return { ok: false, error: `${name}: ${why} Nothing was shown.` };
      }
      let shown: ShowTarget;
      if (item.expression !== undefined) {
        shown = { expression: item.expression, ...(item.scope ? { scope: item.scope } : {}) };
      } else {
        shown = (await selectorFor(item.ref!, answer, post)) ?? { pick: item.ref! };
      }
      items.push({ label: item.label, target: shown, faces, edges });
    }
    return { ok: true, items };
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * The selector the engine synthesized for `ref`, when resolving it again
 * yields exactly that face or edge; null otherwise (no synthesis, a scope it
 * cannot be resolved in again, or another set of matches).
 */
async function selectorFor(
  ref: ShowRef,
  answer: EngineAnswer,
  post: (body: unknown) => Promise<EngineAnswer | { ok: false; error: string }>,
): Promise<ShowTarget | null> {
  const synthesized = answer.synthesized;
  if (!synthesized || synthesized.ok !== true || typeof synthesized.expression !== 'string' || synthesized.expression === '') {
    return null;
  }
  const scope = scopeInput(answer.scope);
  if (scope === null) {
    return null;
  }
  const target: ShowTarget = { expression: synthesized.expression, ...(scope ? { scope } : {}) };
  const again = await post(target);
  if (again.ok === false || again.matches.length !== 1) {
    return null;
  }
  const match = again.matches[0];
  return match.shapeId === ref.shapeId && match.kind === ref.kind && match.index === ref.index ? target : null;
}

/** The scope a resolve answered in, as a request names it; undefined for the root, null for one that cannot be named. */
function scopeInput(scope: EngineAnswer['scope']): SelectionScopeInput | undefined | null {
  if (!scope || scope.kind === 'root') {
    return undefined;
  }
  if (scope.kind === 'part' && typeof scope.part === 'string' && scope.part !== '') {
    return { part: scope.part };
  }
  if (scope.kind === 'sceneObject' && typeof scope.sceneObjectId === 'string') {
    return { sceneObjectId: scope.sceneObjectId };
  }
  if (scope.kind === 'instance' && typeof scope.instanceId === 'string') {
    return { instanceId: scope.instanceId };
  }
  return null;
}

/** What the engine said was wrong, as a clause that follows the item's name. */
function engineError(e: unknown): string {
  if (e instanceof HttpError) {
    try {
      const body = JSON.parse(e.body);
      if (typeof body?.error === 'string' && body.error !== '') {
        return /[.!?]$/.test(body.error) ? body.error : `${body.error}.`;
      }
    } catch {
      // Not JSON: say the status.
    }
    return `the engine refused it (HTTP ${e.statusCode}).`;
  }
  return `the engine could not be asked (${e instanceof Error ? e.message : String(e)}).`;
}
