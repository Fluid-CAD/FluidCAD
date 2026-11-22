// What the CLI is told (docs/agent-chat-plan.md §7.2, §8.3).
//
// The system prompt is the in-app preamble followed by the MCP server's own
// instructions in full: clients truncate long handshake instructions, so
// they are not left to the handshake. Per-turn facts go in the user message
// (`buildCliText`), never in the system prompt.

import { SERVER_INSTRUCTIONS } from '../../mcp/dist/server.js';
import type { AgentRenderState } from '../../server/dist/agent-host.js';
import type { AgentKind, ParamChange, SceneReference } from './types.ts';

/** What the CLI's own tools may do, per agent. */
const OWN_TOOLS: Record<Exclude<AgentKind, 'api'>, string> = {
  claude: 'not available; your own Read, Glob and Grep tools may read files inside the project, and WebSearch\nmay search the web.',
  codex: 'not available (the sandbox is read-only, and apply_patch cannot write); read files with `fluidcad_app`\'s\nread_file. Your web search tool may search the web.',
};

/** Which tools the agent has, and what it may not do (the CLIs reach FluidCAD's as the `fluidcad_app` MCP server). */
function toolsIntro(kind: AgentKind): string[] {
  if (kind === 'api') {
    // FluidCAD's own agent loop: its tools are FluidCAD's and nothing else.
    return [
      'Your tools are FluidCAD\'s, and they are all you have. Their workspace is fixed to this project: there is no',
      '`workspace` argument, and list_workspaces returns this project only.',
      'Read and change the project only with these tools; there is no shell and no file access of your own.',
      'Read files with read_file.',
    ];
  }
  return [
    'Your FluidCAD tools are the `fluidcad_app` MCP server. Its workspace is fixed to this project: there is no',
    '`workspace` argument, and list_workspaces returns this project only.',
    'Read and change the project only with the `fluidcad_app` tools. Shell commands and direct file edits are',
    OWN_TOOLS[kind],
  ];
}

/** The preamble of the system prompt for `kind` (§8.3). */
export function inAppPreamble(kind: AgentKind = 'claude'): string {
  return [
    'You are running inside the FluidCAD app, next to the user, on their open project.',
    'They see the 3D viewport and the feature tree as you work; do not describe what a screenshot would show them.',
    '',
    ...toolsIntro(kind),
    'To learn what the model is and how it is built, use the scene tools first (get_scene_summary, measure,',
    'resolve_selection, screenshot) rather than reading the source files; read a file when you are about to change it.',
    '',
    'Changes may wait for the user\'s approval. When a tool reports that the user declined, or that FluidCAD did',
    'not run it, do not retry it: say what you wanted to do and ask the user how to proceed.',
    'A `dirty-buffer` refusal means the user has unsaved changes in that file: ask them to save it. Never pass',
    '`force`.',
    '',
    'ask_user puts a question to the user as a card with choices and waits for the answer. Use it when a choice is',
    'theirs and a wrong guess would cost real rework (a dimension the request leaves open, which of two readings',
    'they mean); not for what the tools can tell you, and not to confirm a plan. Its description says how.',
    'A question may take `pick` instead of options: the user answers by clicking a face or edges in the viewport. Only when',
    'the answer is a piece of the model the request leaves open and a wrong guess costs rework; not when they attached it',
    'as a scene reference, when what they said identifies it (resolve_selection finds it), or when there is one candidate.',
    '',
    'propose_variants builds two versions of a model file, shows them as 3D tiles and writes the one the user picks. Not by',
    'default: only when they ask to see options, or the form is open and the two look different (a rib versus a gusset);',
    'never for a number they could state, to confirm a plan, or after every change. It costs two full builds; the app waits.',
    '',
    'offer_params puts a few parameters of the rendered model in the chat as live controls, and does not wait. Not by default:',
    'only when a new or reworked model has dimensions the user is likely to tune (they said "roughly", gave a range, are',
    'exploring) or they ask to play with the sizes; never after every edit, for values they fixed, twice for the same',
    'parameters, or in place of a question that blocks the work. Never add a param() only to have something to offer.',
    '',
    '`@path` in the user\'s text names a file of the project by its path from the project\'s root (in quotes when',
    'it has a space: `@"my parts/plate.part.js"`): that file is what they mean. Read it when what they ask depends',
    'on its contents.',
    '',
    'Each user message ends with facts about the app at the moment it was sent:',
    '- `<workspace_state file="…" render="…" unit="…"/>`: the model file on screen (absolute path; absent when',
    '  none is open), how its last render went (`rendered`, `build-error`, `compile-error`, `none`) and the',
    '  project\'s length unit.',
    '- `<attached_images>`, when the user attached images of their own (a drawing, a photo, a screenshot): they',
    '  are the first images of the message, in the order listed, each by its file name.',
    '- `<scene_references>`, when the user attached geometry from the viewport: `[n]` in their text refers to',
    '  `<ref n="…">` and to the geometry drawn in that colour in the capture, the last image of the message',
    '  (`image="attached"`). A ref\'s `selector` is the',
    '  code to write for that geometry: copy it exactly, arguments and filters included (a shorter form selects',
    '  other geometry). When the line naming its feature says "not bound", add',
    '  `const <variable> = ` to that statement first; add the ref\'s `imports` to the file\'s imports.',
    '  To inspect or measure a ref, pass its selector to resolve_selection or measure with the variable replaced',
    '  by `$obj["<id>"]` (the feature\'s id from get_scene_summary), as those tools document.',
    '  A selector describes the model as it was when the message was sent: after an edit that changes the',
    '  features it names, resolve it again before relying on it.',
    '- `<reverted_changes>`, when the user reverted changes you made in an earlier turn: those files are back to',
    '  what they were before that turn, whatever your history shows. Read them again before editing them.',
    '- `<param_changes>`, when the user kept values from a parameter card: each listed `param()` now has that default',
    '  in its file (or, where a configuration is named, that value in the configuration), whatever your history',
    '  shows. Read a file again before editing it, and do not put the old values back.',
    '- `<interrupted_turn>`, when the app restarted while you were working: what you had been asked and how each of',
    '  your tool calls in that turn ended. Check the files and the model, then carry on from where you were.',
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
 * The `<scene_references>` block for a message's references (§11.3): per
 * reference its number, colour, kind and count, the selector to write, the
 * imports it needs, the features it names (and whether their statement has
 * a variable yet), the verified alternatives and the geometry. Null without
 * references. `image`: the capture is attached to the message.
 */
export function formatSceneReferences(references: SceneReference[], options: { image?: boolean } = {}): string | null {
  if (references.length === 0) {
    return null;
  }
  const sorted = [...references].sort((a, b) => a.n - b.n);
  const file = sorted[0].file;
  const unit = sorted[0].unit;
  const head = [
    ...(file ? [`file="${escapeAttr(file)}"`] : []),
    `unit="${escapeAttr(unit)}"`,
    ...(options.image ? ['image="attached"'] : []),
  ];
  const lines = [`<scene_references ${head.join(' ')}>`];
  for (const ref of sorted) {
    const attrs = [
      `n="${Number(ref.n)}"`,
      `color="${escapeAttr(String(ref.color?.name ?? ''))}"`,
      `kind="${escapeAttr(String(ref.kind))}"`,
      `count="${Number(ref.count)}"`,
      ...(ref.file && ref.file !== file ? [`file="${escapeAttr(ref.file)}"`] : []),
      ...(ref.unit !== unit ? [`unit="${escapeAttr(ref.unit)}"`] : []),
    ];
    lines.push(`  <ref ${attrs.join(' ')}>`);
    const words = sceneReferenceWords(ref);
    lines.push(`    selector: ${words.selector}`);
    if (words.imports.length > 0) {
      lines.push(`    imports: ${words.imports.join(', ')}`);
    }
    for (const producer of words.producers) {
      lines.push(`    ${producer}`);
    }
    if (words.alternatives.length > 0) {
      lines.push(`    alternatives: ${words.alternatives.join(' | ')}`);
    }
    if (words.geometry) {
      lines.push(`    geometry: ${words.geometry}`);
    }
    lines.push('  </ref>');
  }
  lines.push('</scene_references>');
  return lines.join('\n');
}

/**
 * What a `<ref>` says of one reference, field by field: the selector to
 * write, the imports it needs, one line per feature it names (and whether
 * its statement has a variable yet), the verified alternatives and the
 * geometry. The block above is made of these, and so is a picked answer to
 * a question (§27), so the agent reads geometry the user pointed at in the
 * same words wherever it comes from. The page builds references: every
 * value is put on one line, whatever it sent.
 */
export function sceneReferenceWords(ref: SceneReference): {
  selector: string;
  imports: string[];
  producers: string[];
  alternatives: string[];
  geometry: string;
} {
  return {
    selector: oneLine(ref.selector.source),
    imports: (ref.selector.imports ?? []).map(oneLine),
    producers: (ref.selector.producers ?? []).map((producer) => oneLine(producerLine(producer))),
    alternatives: (ref.selector.alternatives ?? []).map(oneLine),
    geometry: Array.isArray(ref.geometry) ? oneLine(describeGeometry(ref.geometry as GeometrySummary[])) : '',
  };
}

type Producer = SceneReference['selector']['producers'][number];

function oneLine(value: unknown): string {
  return String(value).replace(/[\r\n]+/g, ' ').replace(/<\/?scene_references\b[^>]*>?/gi, '');
}

function producerLine(p: Producer): string {
  const where = `${p.feature} (${p.featureType})${p.line !== null ? `, line ${p.line}` : ''}`;
  return p.bound
    ? `${p.variable}: \`const ${p.variable} = …\` — ${where}`
    : `${p.variable}: ${where} — not bound: add \`const ${p.variable} = \` to that statement first`;
}

/** `EntitySummary` (lib/oc/measure/entity-summary.ts), as a reference carries it. */
type GeometrySummary = {
  form: string;
  center?: number[];
  normal?: number[];
  axis?: number[];
  area?: number;
  length?: number;
  diameter?: number;
};

/** Measures listed per group before the rest is elided. */
const MAX_GEOMETRY_VALUES = 12;

/**
 * One entity in full ("plane, area 1000, center [20, 12.5, 30], normal
 * [0, 0, 1]"); several grouped by form with their sizes ("4 lines, length
 * 40 / 40 / 25 / 25").
 */
export function describeGeometry(summaries: GeometrySummary[]): string {
  const valid = summaries.filter((s) => s && typeof s.form === 'string');
  if (valid.length === 0) {
    return '';
  }
  if (valid.length === 1) {
    const s = valid[0];
    return [
      s.form,
      ...(s.area !== undefined ? [`area ${s.area}`] : []),
      ...(s.length !== undefined ? [`length ${s.length}`] : []),
      ...(s.diameter !== undefined ? [`diameter ${s.diameter}`] : []),
      ...(s.center ? [`center ${vec(s.center)}`] : []),
      ...(s.normal ? [`normal ${vec(s.normal)}`] : []),
      ...(s.axis ? [`axis ${vec(s.axis)}`] : []),
    ].join(', ');
  }
  const groups = new Map<string, GeometrySummary[]>();
  for (const s of valid) {
    groups.set(s.form, [...(groups.get(s.form) ?? []), s]);
  }
  return [...groups].map(([form, group]) => {
    const parts = [`${group.length} ${plural(form, group.length)}`];
    for (const key of ['area', 'length', 'diameter'] as const) {
      const values = group.map((s) => s[key]).filter((v): v is number => typeof v === 'number');
      if (values.length > 0) {
        const shown = values.slice(0, MAX_GEOMETRY_VALUES).join(' / ');
        parts.push(`${key} ${shown}${values.length > MAX_GEOMETRY_VALUES ? ' / …' : ''}`);
      }
    }
    return parts.join(', ');
  }).join('; ');
}

function plural(form: string, count: number): string {
  if (count === 1) {
    return form;
  }
  if (form === 'torus') {
    return 'tori';
  }
  return form.endsWith('s') ? `${form}es` : `${form}s`;
}

function vec(v: number[]): string {
  return `[${v.join(', ')}]`;
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

/**
 * The note the CLI gets with the next message after the user kept values
 * from a parameter card (§26): its own history still holds the old defaults.
 * Labels, part names and values are the model file's and the user's: each
 * stays on its line and opens or closes no tag.
 */
export function paramChangesNote(changes: ParamChange[]): string {
  const list = changes.map((change) => {
    const where = change.part ? ` of ${quoted(change.part)}` : '';
    const row = change.configuration ? ` (configuration ${quoted(change.configuration)})` : '';
    return `- ${oneLine(change.file).replace(/[<>]/g, '')}: ${quoted(change.label)}${where} = ${quoted(change.value)}${row}`;
  });
  return (
    '<param_changes>\n' +
    'The user kept these values from a parameter card in the chat. Each is now in the source, as the default of its ' +
    'param() (or, where a configuration is named, as that configuration\'s value), whatever your history shows:\n' +
    `${list.join('\n')}\n` +
    '</param_changes>'
  );
}

/** A label or a value as JSON, on one line, with nothing a tag could start with. */
function quoted(value: unknown): string {
  return JSON.stringify(value).replace(/[<>]/g, '');
}

/** One tool call of an interrupted turn, as the continue note lists it. */
export type InterruptedToolCall = {
  name: string;
  /** What it worked on (a workspace-relative path), when it says. */
  target?: string;
  /** How it ended: "done", "result unknown (…)", "failed: …", "declined by the user", … */
  outcome: string;
};

/** The longest the user's request is quoted in the continue note. */
const MAX_REQUEST_CHARS = 600;
/** The most tool calls the continue note lists (the latest ones). */
const MAX_LISTED_CALLS = 25;

/**
 * What the CLI is told, with {@link CONTINUE_TEXT}, about the turn an
 * engine restart cut off (§12.3): what the user had asked (shortened), and
 * each tool call of that turn with how it ended, so the agent can check the
 * model and carry on rather than start over or lose track.
 */
export function interruptedTurnNote(input: { request: string | null; calls: InterruptedToolCall[] }): string {
  const lines = ['<interrupted_turn>'];
  const request = input.request?.trim();
  if (request) {
    const quoted = request.length > MAX_REQUEST_CHARS ? `${request.slice(0, MAX_REQUEST_CHARS - 1).trimEnd()}…` : request;
    lines.push('The user had asked:', ...quoted.split('\n').map((l) => `> ${l}`));
  }
  if (input.calls.length === 0) {
    lines.push('No tool call of that turn had started.');
  } else {
    const shown = input.calls.slice(-MAX_LISTED_CALLS);
    const skipped = input.calls.length - shown.length;
    lines.push(`Your tool calls in that turn, in order, and how each ended${skipped > 0 ? ` (the last ${shown.length}; ${skipped} earlier ones left out)` : ''}:`);
    for (const call of shown) {
      lines.push(`- ${oneLine(call.name)}${call.target ? ` ${oneLine(call.target)}` : ''} — ${oneLine(call.outcome)}`);
    }
    lines.push('A call whose result is unknown may or may not have changed the files: read them and look at the model before you redo it.');
  }
  lines.push('</interrupted_turn>');
  return lines.join('\n');
}

/** The text the CLI gets for a user message (§7.2). */
export function buildCliText(input: {
  text: string;
  /** The file names of the images the user attached, in order ({@link attachedImagesTag}). */
  attachedImages?: string[];
  references?: SceneReference[];
  /** The references capture goes with the message, after the user's images. */
  imageAttached?: boolean;
  workspace: WorkspaceState;
  /** Files reverted since the CLI was last told (§12.2). */
  revertedFiles?: string[];
  /** Values kept from a parameter card since the CLI was last told (§26). */
  paramChanges?: ParamChange[];
  /** The note about a turn an engine restart cut off ({@link interruptedTurnNote}), when continuing it. */
  interruptedTurn?: string;
}): string {
  // A message of images only has no words of its own.
  const blocks = input.text.trim() === '' ? [] : [input.text.trim()];
  const references = input.references && input.references.length > 0 ? formatSceneReferences(input.references, { image: input.imageAttached }) : null;
  const tail: string[] = [];
  if (input.interruptedTurn) {
    tail.push(input.interruptedTurn);
  }
  if (input.revertedFiles && input.revertedFiles.length > 0) {
    tail.push(revertedChangesNote(input.revertedFiles));
  }
  if (input.paramChanges && input.paramChanges.length > 0) {
    tail.push(paramChangesNote(input.paramChanges));
  }
  if (input.attachedImages && input.attachedImages.length > 0) {
    tail.push(attachedImagesTag(input.attachedImages));
  }
  if (references) {
    tail.push(references);
  }
  tail.push(workspaceStateTag(input.workspace));
  blocks.push(tail.join('\n'));
  return blocks.join('\n\n');
}

/** The `<attached_images>` block: the user's images in the order the message carries them, by file name. */
export function attachedImagesTag(names: string[]): string {
  return [
    `<attached_images count="${names.length}">`,
    // A name is the user's file's: it stays on its line and opens or closes no tag.
    ...names.map((name, i) => `  ${i + 1}: ${oneLine(name).replace(/[<>]/g, '')}`),
    '</attached_images>',
  ].join('\n');
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
