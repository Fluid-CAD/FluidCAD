// What the CLI is told (docs/agent-chat-plan.md §7.2, §8.3).
//
// The system prompt is the in-app preamble followed by the MCP server's own
// instructions in full: clients truncate long handshake instructions, so
// they are not left to the handshake. Per-turn facts go in the user message
// (`buildCliText`), never in the system prompt.

import { SERVER_INSTRUCTIONS } from '../../mcp/dist/server.js';
import type { AgentRenderState } from '../../server/dist/agent-host.js';
import type { AgentKind, SceneReference } from './types.ts';

/** What the CLI's own tools may do, per agent. */
const OWN_TOOLS: Record<AgentKind, string> = {
  claude: 'not available; your own Read, Glob and Grep tools may read files inside the project.',
  codex: 'not available (the sandbox is read-only, and apply_patch cannot write); read files with `fluidcad_app`\'s\nread_file.',
};

/** The preamble of the system prompt for `kind` (§8.3). */
export function inAppPreamble(kind: AgentKind = 'claude'): string {
  return [
    'You are running inside the FluidCAD app, next to the user, on their open project.',
    'They see the 3D viewport and the feature tree as you work; do not describe what a screenshot would show them.',
    '',
    'Your FluidCAD tools are the `fluidcad_app` MCP server. Its workspace is fixed to this project: there is no',
    '`workspace` argument, and list_workspaces returns this project only.',
    'Read and change the project only with the `fluidcad_app` tools. Shell commands and direct file edits are',
    OWN_TOOLS[kind],
    '',
    'Changes may wait for the user\'s approval. When a tool reports that the user declined, or that FluidCAD did',
    'not run it, do not retry it: say what you wanted to do and ask the user how to proceed.',
    'A `dirty-buffer` refusal means the user has unsaved changes in that file: ask them to save it. Never pass',
    '`force`.',
    '',
    'Each user message ends with facts about the app at the moment it was sent:',
    '- `<workspace_state file="…" render="…" unit="…"/>`: the model file on screen (absolute path; absent when',
    '  none is open), how its last render went (`rendered`, `build-error`, `compile-error`, `none`) and the',
    '  project\'s length unit.',
    '- `<scene_references>`, when the user attached geometry from the viewport: `[n]` in their text refers to',
    '  `<ref n="…">` and to the geometry drawn in that colour in the attached image. Each ref\'s `selector` is the',
    '  code to write for that geometry.',
    '- `<reverted_changes>`, when the user reverted changes you made in an earlier turn: those files are back to',
    '  what they were before that turn, whatever your history shows. Read them again before editing them.',
  ].join('\n');
}

/** Claude Code's preamble. */
export const IN_APP_PREAMBLE = inAppPreamble('claude');

/** The full system prompt for a chat session's CLI. */
export function composeInstructions(kind: AgentKind = 'claude'): string {
  return `${inAppPreamble(kind)}\n\n---\n\n${SERVER_INSTRUCTIONS}`;
}

export type WorkspaceState = {
  file: string | null;
  render: AgentRenderState['state'];
  unit: string;
};

/**
 * The `<scene_references>` block for a message's references (§11.3).
 * Phase 6 writes it; until then references are kept in the transcript only.
 */
export function formatSceneReferences(_references: SceneReference[]): string | null {
  return null;
}

/**
 * The note the CLI gets with the next message after a revert (§12.2): its
 * own history still holds the edits the user undid.
 */
export function revertedChangesNote(files: string[]): string {
  const list = files.map((f) => `- ${f}`).join('\n');
  return (
    '<reverted_changes>\n' +
    'The user reverted changes you made earlier in this conversation. These files are back to what they were ' +
    'before those changes (a file you had created no longer exists):\n' +
    `${list}\n` +
    '</reverted_changes>'
  );
}

/** The text the CLI gets for a user message (§7.2). */
export function buildCliText(input: {
  text: string;
  references?: SceneReference[];
  workspace: WorkspaceState;
  /** Files reverted since the CLI was last told (§12.2). */
  revertedFiles?: string[];
}): string {
  const blocks = [input.text.trim()];
  const references = input.references && input.references.length > 0 ? formatSceneReferences(input.references) : null;
  const tail: string[] = [];
  if (input.revertedFiles && input.revertedFiles.length > 0) {
    tail.push(revertedChangesNote(input.revertedFiles));
  }
  if (references) {
    tail.push(references);
  }
  tail.push(workspaceStateTag(input.workspace));
  blocks.push(tail.join('\n'));
  return blocks.join('\n\n');
}

export function workspaceStateTag(state: WorkspaceState): string {
  const attrs = [
    ...(state.file ? [`file="${escapeAttr(state.file)}"`] : []),
    `render="${escapeAttr(state.render)}"`,
    `unit="${escapeAttr(state.unit)}"`,
  ];
  return `<workspace_state ${attrs.join(' ')}/>`;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** What the CLI is told when the user continues after an engine restart (§12.3). */
export const CONTINUE_TEXT =
  'The app restarted while you were working. Your last tool call may or may not have completed. ' +
  'Check the current state of the model before continuing.';
