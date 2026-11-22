// What the agent points at (`show_user`, docs/agent-chat-plan.md §27): what a
// call's items become on the card, and what the model is told about them.
//
// The items are resolved against the engine's current scene by the MCP
// package (`resolveShowItems`), the way `resolve_selection` resolves a
// selector: a call is refused when any item resolves to nothing. The card
// then carries, per item, what to resolve *again* — never the shape ids it
// resolved to, which are one render's. The page that shows the card resolves
// the items against the model on its screen, draws them, and says which of
// them no longer resolve after an edit. The session only puts the card in
// the transcript.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { resolveShowItems, SHOW_USER_COLORS, type RegistryEntry, type ShowUserInput } from '../../mcp/dist/server.js';
import type { ShowItem, ShowPart } from './types.ts';

export const NO_MODEL_TO_SHOW_MESSAGE = 'No model is on screen, so there is nothing to point at. Open or render a model file first.';

export type ReadShow = { ok: true; card: Omit<ShowPart, 'type' | 'id'> } | { ok: false; error: string };

/**
 * The card a call makes, or what is wrong with the call in words the model
 * can correct it from (an item that resolves to nothing, named by its number
 * and label). `file` is the model on screen: the items are of that file, and
 * a page showing another one does not draw them.
 */
export async function readShow(
  input: ShowUserInput,
  deps: { pinnedWorkspace: RegistryEntry; file: string | null; relative(absPath: string): string },
): Promise<ReadShow> {
  if (!deps.file) {
    return { ok: false, error: NO_MODEL_TO_SHOW_MESSAGE };
  }
  // Labels and the note are the model's words: one line each, shown as text.
  const items = input.items.map((item) => ({ ...item, label: oneLine(item.label) }));
  const resolved = await resolveShowItems({ items }, { pinnedWorkspace: deps.pinnedWorkspace });
  if (resolved.ok === false) {
    return { ok: false, error: resolved.error };
  }
  const note = input.note === undefined ? '' : oneLine(input.note);
  return {
    ok: true,
    card: {
      file: deps.relative(deps.file),
      absPath: deps.file,
      ...(note ? { note } : {}),
      items: resolved.items.map((item, index): ShowItem => ({
        n: index + 1,
        color: SHOW_USER_COLORS[index % SHOW_USER_COLORS.length],
        label: item.label,
        target: item.target,
        faces: item.faces,
        edges: item.edges,
      })),
    },
  };
}

/** What `show_user` returns to the model: each item's chip and what it resolved to. */
export function showResult(card: Pick<ShowPart, 'items'>): CallToolResult {
  const shown = card.items.map((item) => ({ n: item.n, color: item.color, label: item.label, faces: item.faces, edges: item.edges }));
  return { content: [{ type: 'text', text: JSON.stringify({ shown }) }] };
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
