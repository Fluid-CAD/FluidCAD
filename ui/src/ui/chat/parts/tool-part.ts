import { ChatIcons } from '../chat-icons';
import type { ChatPart, ToolPart } from '../chat-types';
import type { PartContext, PartView } from './part-view';

/** The longest input summary shown on the card's line. */
const SUMMARY_CHARS = 90;
/** The longest output shown in the card's details (the transcript keeps up to 20 000 characters). */
const OUTPUT_CHARS = 8000;

/** Input fields worth naming on the card's one line, in order of preference. */
const SUMMARY_KEYS = [
  'query', 'pattern', 'selector', 'name', 'id', 'shapeId', 'faceId', 'edgeId', 'file_path', 'path', 'glob', 'expression', 'url',
];

/**
 * One line about a tool call's input: the field that says most about it
 * (a query, a pattern, a path, a name), else the first short values. The
 * title already names the tool and often the file.
 */
export function summarizeToolInput(input: unknown, title = ''): string {
  if (input === null || input === undefined) {
    return '';
  }
  if (typeof input !== 'object') {
    return clip(String(input));
  }
  const record = input as Record<string, unknown>;
  const pieces: string[] = [];
  for (const key of SUMMARY_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') {
      // A value the title already says (the file of a read, by its path) is noise.
      const tail = value.trim().split(/[\\/]/).pop() ?? '';
      if (tail !== '' && title.includes(tail)) {
        return '';
      }
      pieces.push(value.trim());
      break;
    }
  }
  if (pieces.length === 0) {
    for (const [key, value] of Object.entries(record)) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        pieces.push(`${key}: ${String(value)}`);
      }
      if (pieces.length >= 2) {
        break;
      }
    }
  }
  return clip(pieces.join(' · ').replace(/\s+/g, ' '));
}

function clip(text: string): string {
  return text.length > SUMMARY_CHARS ? `${text.slice(0, SUMMARY_CHARS - 1)}…` : text;
}

/** A render's outcome, as a write or recompute tool reports it (mcp `RenderOutcome`). */
export type RenderOutcomeView =
  | { state: 'rendered' }
  | { state: 'build-error'; errors: { name: string; message: string; location?: SourceLocation }[] }
  | { state: 'compile-error'; message: string; location?: SourceLocation }
  | { state: 'render-failed'; message: string };

type SourceLocation = { filePath: string; line: number; column: number };

/** The render outcome in a tool's output text (JSON with a `render` field, or the outcome itself), or null. */
export function readRenderOutcome(text: string | undefined): RenderOutcomeView | null {
  if (!text || !text.trimStart().startsWith('{')) {
    return null;
  }
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const outcome = json && typeof json.render === 'object' && json.render ? json.render : json;
  switch (outcome?.state) {
    case 'rendered':
      return { state: 'rendered' };
    case 'build-error': {
      const errors = Array.isArray(outcome.objectErrors) ? outcome.objectErrors : [];
      return {
        state: 'build-error',
        errors: errors.map((e: any) => ({
          name: String(e?.name ?? 'A feature'),
          message: String(e?.message ?? ''),
          ...(isLocation(e?.sourceLocation) ? { location: e.sourceLocation } : {}),
        })),
      };
    }
    case 'compile-error': {
      const error = outcome.compileError ?? {};
      return {
        state: 'compile-error',
        message: String(error.message ?? 'The code does not compile.'),
        ...(isLocation(error.sourceLocation) ? { location: error.sourceLocation } : {}),
      };
    }
    case 'render-failed':
      return { state: 'render-failed', message: String(outcome.error ?? 'The render failed.') };
    default:
      return null;
  }
}

function isLocation(value: any): value is SourceLocation {
  return !!value && typeof value.filePath === 'string' && typeof value.line === 'number';
}

const STATE_TEXT: Record<ToolPart['state'], string> = {
  running: 'Running',
  'awaiting-approval': 'Waiting for approval',
  done: 'Done',
  error: 'Failed',
  denied: 'Not run',
};

/**
 * A tool call as a card (docs/agent-chat-plan.md §10.3): its status, title
 * and a line about its input; under it whatever the call produced that the
 * user should see at once (a render's outcome with links to the line, the
 * images it returned, the error); and, on a click, the raw input and
 * output.
 *
 * **Phase 4 plugs in here:** the `approval` slot (`data-ref="approval"`)
 * holds the "Waiting for approval" line today and takes Allow / Allow for
 * this session / Deny; `diff` already renders when a part carries one.
 */
export class ToolPartView implements PartView {
  readonly el: HTMLDivElement;
  private readonly header: HTMLButtonElement;
  private readonly statusIcon: HTMLSpanElement;
  private readonly title: HTMLSpanElement;
  private readonly summary: HTMLSpanElement;
  private readonly chevron: HTMLSpanElement;
  /** Phase 4's approval buttons go here. */
  readonly approval: HTMLDivElement;
  private readonly outcome: HTMLDivElement;
  private readonly images: HTMLDivElement;
  private readonly errorLine: HTMLDivElement;
  private readonly details: HTMLDivElement;
  private expanded = false;
  private part: ToolPart;

  constructor(part: ToolPart, private readonly ctx: PartContext) {
    this.part = part;
    this.el = document.createElement('div');
    this.el.className = 'chat-tool';
    this.el.dataset.part = 'tool';

    this.header = document.createElement('button');
    this.header.type = 'button';
    this.header.dataset.ref = 'toggle';
    this.header.className = 'chat-tool-header';
    this.statusIcon = document.createElement('span');
    this.statusIcon.className = 'chat-tool-status';
    this.title = document.createElement('span');
    this.title.className = 'chat-tool-title';
    this.title.dataset.ref = 'title';
    this.summary = document.createElement('span');
    this.summary.className = 'chat-tool-summary';
    this.summary.dataset.ref = 'summary';
    this.chevron = ChatIcons.span(ChatIcons.CHEVRON_RIGHT, '[&>svg]:size-3 chat-chevron ml-auto');
    this.header.append(this.statusIcon, this.title, this.summary, this.chevron);
    this.header.addEventListener('click', () => {
      this.expanded = !this.expanded;
      this.paint();
    });

    this.approval = div('chat-tool-approval', 'approval');
    this.outcome = div('chat-tool-outcome', 'outcome');
    this.images = div('chat-tool-images', 'images');
    this.errorLine = div('chat-tool-error', 'error');
    this.details = div('chat-tool-details', 'details');
    this.el.append(this.header, this.approval, this.outcome, this.images, this.errorLine, this.details);
    this.paint();
  }

  update(part: ChatPart): void {
    if (part.type === 'tool') {
      this.part = part;
      this.paint();
    }
  }

  private paint(): void {
    const part = this.part;
    this.el.dataset.state = part.state;
    this.el.dataset.kind = part.kind;
    this.el.dataset.name = part.name;

    this.statusIcon.replaceChildren(statusIcon(part.state));
    this.statusIcon.title = STATE_TEXT[part.state];
    this.title.textContent = part.title || part.name;
    this.summary.textContent = summarizeToolInput(part.input, this.title.textContent);
    this.chevron.classList.toggle('rotate-90', this.expanded);
    this.header.setAttribute('aria-expanded', String(this.expanded));

    // Waiting for approval: a plain line until phase 4 brings the buttons.
    this.approval.replaceChildren();
    if (part.state === 'awaiting-approval') {
      this.approval.append(ChatIcons.span(ChatIcons.WAITING, '[&>svg]:size-3.5'), text('Waiting for approval…'));
    }
    this.approval.classList.toggle('hidden', part.state !== 'awaiting-approval');

    this.paintOutcome(readRenderOutcome(part.output?.text));
    this.paintImages(part.output?.images ?? []);

    const showError = (part.state === 'error' || part.state === 'denied') && !!part.error;
    this.errorLine.textContent = showError ? firstLine(part.error!) : '';
    this.errorLine.classList.toggle('hidden', !showError);

    this.details.classList.toggle('hidden', !this.expanded);
    if (this.expanded) {
      this.paintDetails();
    } else {
      this.details.replaceChildren();
    }
  }

  private paintOutcome(outcome: RenderOutcomeView | null): void {
    this.outcome.replaceChildren();
    this.outcome.classList.toggle('hidden', outcome === null);
    if (!outcome) {
      return;
    }
    this.outcome.dataset.outcome = outcome.state;
    switch (outcome.state) {
      case 'rendered':
        this.outcome.append(ChatIcons.span(ChatIcons.CHECK, '[&>svg]:size-3.5 text-success'), text('Rendered'));
        return;
      case 'compile-error':
        this.outcome.append(this.outcomeRow('Compile error', outcome.message, outcome.location));
        return;
      case 'render-failed':
        this.outcome.append(this.outcomeRow('Render failed', outcome.message));
        return;
      case 'build-error':
        if (outcome.errors.length === 0) {
          this.outcome.append(this.outcomeRow('Build error', 'A feature failed to build.'));
        }
        for (const error of outcome.errors) {
          this.outcome.append(this.outcomeRow(`${error.name} failed`, error.message, error.location));
        }
        return;
    }
  }

  private outcomeRow(label: string, message: string, location?: SourceLocation): HTMLElement {
    const row = document.createElement('div');
    row.className = 'chat-tool-outcome-row';
    row.append(ChatIcons.span(ChatIcons.ERROR, '[&>svg]:size-3.5 text-error'));
    const words = document.createElement('span');
    const strong = document.createElement('span');
    strong.className = 'font-medium';
    strong.textContent = `${label}: `;
    words.append(strong, text(message));
    row.append(words);
    if (location) {
      const name = location.filePath.split(/[\\/]/).pop() ?? location.filePath;
      const where = `${name}:${location.line}`;
      if (this.ctx.openSource) {
        const link = document.createElement('button');
        link.type = 'button';
        link.dataset.ref = 'source-link';
        link.className = 'link link-hover font-mono text-[11px] shrink-0';
        link.textContent = where;
        link.title = `Show ${location.filePath}, line ${location.line}`;
        link.addEventListener('click', () => this.ctx.openSource?.(location.filePath, location.line, location.column ?? 1));
        row.append(link);
      } else {
        const plain = document.createElement('span');
        plain.className = 'font-mono text-[11px] shrink-0 opacity-70';
        plain.textContent = where;
        row.append(plain);
      }
    }
    return row;
  }

  private paintImages(names: string[]): void {
    const current = [...this.images.querySelectorAll('img')].map((img) => img.dataset.file);
    if (current.length === names.length && current.every((n, i) => n === names[i])) {
      return;
    }
    this.images.replaceChildren();
    for (const name of names) {
      const img = document.createElement('img');
      img.dataset.file = name;
      img.src = this.ctx.fileUrl(name);
      img.alt = 'An image the tool returned';
      img.loading = 'lazy';
      img.addEventListener('click', () => img.classList.toggle('chat-tool-image-full'));
      this.images.append(img);
    }
    this.images.classList.toggle('hidden', names.length === 0);
  }

  private paintDetails(): void {
    const part = this.part;
    this.details.replaceChildren();
    const name = document.createElement('div');
    name.className = 'chat-tool-name';
    name.textContent = part.source === 'agent' ? `${part.name} (the agent's own tool)` : part.name;
    this.details.append(name);
    this.details.append(section('Input', formatInput(part.input)));
    if (part.diff) {
      this.details.append(diffSection(part.diff));
    }
    if (part.output?.text) {
      this.details.append(section('Output', clipOutput(prettyJson(part.output.text))));
    }
    if (part.error) {
      this.details.append(section(part.state === 'denied' ? 'Not run' : 'Error', part.error));
    }
  }
}

function statusIcon(state: ToolPart['state']): HTMLElement {
  switch (state) {
    case 'running': {
      const spinner = document.createElement('span');
      spinner.className = 'loading loading-spinner loading-xs text-base-content/50';
      return spinner;
    }
    case 'awaiting-approval':
      return ChatIcons.span(ChatIcons.WAITING, '[&>svg]:size-3.5 text-warning');
    case 'done':
      return ChatIcons.span(ChatIcons.CHECK, '[&>svg]:size-3.5 text-success');
    case 'error':
      return ChatIcons.span(ChatIcons.ERROR, '[&>svg]:size-3.5 text-error');
    case 'denied':
      return ChatIcons.span(ChatIcons.DENIED, '[&>svg]:size-3.5 text-base-content/50');
  }
}

function div(className: string, ref: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = `${className} hidden`;
  el.dataset.ref = ref;
  return el;
}

function text(value: string): Text {
  return document.createTextNode(value);
}

function firstLine(value: string): string {
  const line = value.trim().split('\n')[0] ?? '';
  return line.length > 240 ? `${line.slice(0, 239)}…` : line;
}

function formatInput(input: unknown): string {
  if (input === undefined) {
    return '';
  }
  try {
    return JSON.stringify(input, null, 2) ?? '';
  } catch {
    return String(input);
  }
}

/** JSON output indented for reading; anything else as it is. */
function prettyJson(value: string): string {
  const trimmed = value.trim();
  if (!(trimmed.startsWith('{') || trimmed.startsWith('[')) || trimmed.length > 200_000) {
    return value;
  }
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return value;
  }
}

function clipOutput(value: string): string {
  return value.length > OUTPUT_CHARS ? `${value.slice(0, OUTPUT_CHARS)}\n… (${value.length - OUTPUT_CHARS} more characters)` : value;
}

function section(label: string, body: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'chat-tool-section';
  const heading = document.createElement('div');
  heading.className = 'chat-tool-section-label';
  heading.textContent = label;
  const pre = document.createElement('pre');
  pre.textContent = body;
  wrap.append(heading, pre);
  return wrap;
}

/** A unified diff, each line tinted by its sign. */
function diffSection(diff: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'chat-tool-section';
  wrap.dataset.ref = 'diff';
  const heading = document.createElement('div');
  heading.className = 'chat-tool-section-label';
  heading.textContent = 'Change';
  const pre = document.createElement('pre');
  pre.className = 'chat-diff';
  for (const line of diff.split('\n')) {
    const span = document.createElement('span');
    if (line.startsWith('+') && !line.startsWith('+++')) {
      span.className = 'chat-diff-add';
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      span.className = 'chat-diff-del';
    } else if (line.startsWith('@@')) {
      span.className = 'chat-diff-hunk';
    }
    span.textContent = `${line}\n`;
    pre.append(span);
  }
  wrap.append(heading, pre);
  return wrap;
}
