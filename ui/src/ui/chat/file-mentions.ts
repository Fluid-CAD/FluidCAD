import { fuzzyScore } from '../../editor/fuzzy-score';
import { ASSEMBLY_ACCENT, splitModelName } from '../../editor/model-name';
import { ICON_CUBE, ICON_FILE_CODE } from '../icons';

/** A project file a message can name: its workspace-relative path and what it is. */
export type MentionFile = {
  /** Workspace-relative, forward slashes. */
  path: string;
  kind: 'model' | 'source' | 'other';
};

export type FileMentionsDeps = {
  textarea: HTMLTextAreaElement;
  /** What the list is positioned against: it opens above this element, as wide as it. */
  host: HTMLElement;
  /** The project's files, read again each time a mention is started. */
  listFiles(): Promise<MentionFile[]>;
  /** Put `text` in place of the textarea's `start`..`end` and leave the caret after it. */
  onReplace(start: number, end: number, text: string): void;
};

/** The most files the list offers; typing narrows it. */
const MAX_RESULTS = 8;

/** Models before the modules they import, before everything else. */
const KIND_ORDER: Record<MentionFile['kind'], number> = { model: 0, source: 1, other: 2 };

/**
 * The mention being typed at `caret`: an `@` that starts a word (the text's
 * start, or after a space or an opening bracket, so an email address is not
 * one) and what follows it up to the caret, with no space in it. Null when
 * the caret is not in one.
 */
export function mentionAt(value: string, caret: number): { start: number; query: string } | null {
  const match = /(?:^|[\s([{])@([^\s@]*)$/.exec(value.slice(0, caret));
  if (!match) {
    return null;
  }
  return { start: caret - match[1].length - 1, query: match[1] };
}

/**
 * The files `query` offers, best first: by how closely the path matches,
 * then models before modules before the rest, then by path. An empty query
 * offers the first files in that order.
 */
export function rankMentions(files: readonly MentionFile[], query: string, max = MAX_RESULTS): MentionFile[] {
  return files
    .map((file) => ({ file, score: fuzzyScore(file.path, query) }))
    .filter((row): row is { file: MentionFile; score: number } => row.score !== null)
    .sort((a, b) =>
      a.score - b.score ||
      KIND_ORDER[a.file.kind] - KIND_ORDER[b.file.kind] ||
      a.file.path.localeCompare(b.file.path))
    .slice(0, max)
    .map((row) => row.file);
}

/** How a file is written in the message: `@path`, in quotes when the path has a space. */
export function mentionText(path: string): string {
  return /\s/.test(path) ? `@"${path}"` : `@${path}`;
}

let nextListId = 0;

/**
 * File mentions in the composer: typing `@` opens a list of the project's
 * files above the box, narrowed as the name is typed (the `+` picker's fuzzy
 * match). Up and Down move the highlight, Enter or Tab (or a click) puts the
 * file's workspace-relative path in the text as `@path`, Escape closes the
 * list and leaves what was typed. The agent reads `@path` as that file
 * (`agent/src/instructions.ts`).
 *
 * The composer hands its keys over first ({@link handleKey}): while the list
 * offers a file, Enter picks it instead of sending.
 */
export class FileMentions {
  private readonly list: HTMLDivElement;
  private mention: { start: number; query: string } | null = null;
  /** The `@` Escape closed the list on: it stays closed until another is typed. */
  private dismissedAt: number | null = null;
  /** Null while the listing loads. */
  private files: MentionFile[] | null = null;
  private results: MentionFile[] = [];
  private rows: HTMLElement[] = [];
  private highlighted = 0;
  /** Counts mentions started, so a listing that arrives late for an earlier one is dropped. */
  private generation = 0;
  /** Where the pointer last moved over the list; a list redrawn under a resting pointer is no move. */
  private lastPointer: { x: number; y: number } | null = null;

  constructor(private readonly deps: FileMentionsDeps) {
    this.list = document.createElement('div');
    this.list.className = 'chat-mentions hidden';
    this.list.dataset.ref = 'mentions';
    this.list.id = `chat-mentions-${++nextListId}`;
    this.list.setAttribute('role', 'listbox');
    this.list.setAttribute('aria-label', 'Project files');
    // A press on the list must not take the focus (and the caret) from the textarea.
    this.list.addEventListener('mousedown', (event) => event.preventDefault());
    this.list.addEventListener('pointermove', (event) => {
      if (this.lastPointer?.x === event.clientX && this.lastPointer.y === event.clientY) {
        return;
      }
      this.lastPointer = { x: event.clientX, y: event.clientY };
      const row = (event.target as Element).closest<HTMLElement>('[data-index]');
      const index = row ? Number(row.dataset.index) : -1;
      if (index >= 0 && index !== this.highlighted) {
        this.highlighted = index;
        this.syncHighlight();
      }
    });
    deps.host.appendChild(this.list);

    const { textarea } = deps;
    textarea.setAttribute('aria-autocomplete', 'list');
    textarea.setAttribute('aria-controls', this.list.id);
    textarea.setAttribute('aria-expanded', 'false');
    textarea.addEventListener('input', () => this.update());
    textarea.addEventListener('click', () => this.update());
    // The caret keys move it in or out of a mention.
    textarea.addEventListener('keyup', (event) => {
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
        this.update();
      }
    });
    textarea.addEventListener('blur', () => this.close());
  }

  get isOpen(): boolean {
    return this.mention !== null;
  }

  /** A key pressed in the textarea; true when the list took it. */
  handleKey(event: KeyboardEvent): boolean {
    if (!this.mention || event.isComposing) {
      return false;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.dismissedAt = this.mention.start;
      this.close();
      return true;
    }
    if (this.results.length === 0) {
      // Nothing to pick: Enter sends the message as typed.
      return false;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      this.highlighted = (this.highlighted + step + this.results.length) % this.results.length;
      this.syncHighlight();
      this.rows[this.highlighted]?.scrollIntoView?.({ block: 'nearest' });
      return true;
    }
    const plain = !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey;
    if ((event.key === 'Enter' || event.key === 'Tab') && plain) {
      event.preventDefault();
      this.pick(this.highlighted);
      return true;
    }
    return false;
  }

  /** Open, narrow or close the list for where the caret now is. */
  private update(): void {
    const { textarea } = this.deps;
    const collapsed = textarea.selectionStart === textarea.selectionEnd;
    const mention = collapsed ? mentionAt(textarea.value, textarea.selectionStart) : null;
    if (!mention) {
      this.dismissedAt = null;
      this.close();
      return;
    }
    if (mention.start === this.dismissedAt) {
      return;
    }
    this.dismissedAt = null;
    const started = !this.mention || this.mention.start !== mention.start;
    if (!started && this.mention!.query === mention.query) {
      return;
    }
    this.mention = mention;
    this.highlighted = 0;
    if (started) {
      this.load();
    }
    this.render();
  }

  private load(): void {
    const generation = ++this.generation;
    this.files = null;
    this.deps.listFiles().then(
      (files) => files,
      (err) => {
        console.warn('FluidCAD: the project\'s files could not be listed:', err);
        return [] as MentionFile[];
      },
    ).then((files) => {
      if (generation === this.generation && this.mention) {
        this.files = files;
        this.render();
      }
    });
  }

  private close(): void {
    if (!this.mention) {
      return;
    }
    this.mention = null;
    this.generation++;
    this.results = [];
    this.rows = [];
    this.lastPointer = null;
    this.list.classList.add('hidden');
    this.list.replaceChildren();
    this.deps.textarea.setAttribute('aria-expanded', 'false');
    this.deps.textarea.removeAttribute('aria-activedescendant');
  }

  private pick(index: number): void {
    const file = this.results[index];
    const mention = this.mention;
    if (!file || !mention) {
      return;
    }
    const { textarea } = this.deps;
    const end = mention.start + 1 + mention.query.length;
    // A space after it, unless one is there: the next word is not part of the path.
    const trail = /^\s/.test(textarea.value.slice(end)) ? '' : ' ';
    this.close();
    this.deps.onReplace(mention.start, end, `${mentionText(file.path)}${trail}`);
  }

  private render(): void {
    if (!this.mention) {
      return;
    }
    this.results = this.files ? rankMentions(this.files, this.mention.query) : [];
    this.highlighted = Math.min(this.highlighted, Math.max(0, this.results.length - 1));
    this.rows = this.results.map((file, index) => this.buildRow(file, index));
    if (this.rows.length > 0) {
      this.list.replaceChildren(...this.rows);
    } else {
      const empty = document.createElement('div');
      empty.className = 'chat-mentions-empty';
      empty.textContent = this.files === null
        ? 'Loading files…'
        : this.files.length === 0 ? 'No files in this project.' : 'No matching files.';
      this.list.replaceChildren(empty);
    }
    this.list.classList.remove('hidden');
    this.deps.textarea.setAttribute('aria-expanded', 'true');
    this.syncHighlight();
  }

  /** One file: its icon, its name, and the folder it is in. */
  private buildRow(file: MentionFile, index: number): HTMLElement {
    const slash = file.path.lastIndexOf('/');
    const basename = file.path.slice(slash + 1);
    const row = document.createElement('div');
    row.className = 'chat-mentions-row';
    row.id = `${this.list.id}-${index}`;
    row.dataset.index = String(index);
    row.dataset.path = file.path;
    row.setAttribute('role', 'option');
    row.title = file.path;

    const icon = document.createElement('span');
    icon.className = 'chat-mentions-icon';
    icon.innerHTML = file.kind === 'model' ? ICON_CUBE : ICON_FILE_CODE;
    if (file.kind === 'model') {
      // A part's cube in the primary blue, an assembly's in its teal, as the file tabs tint theirs.
      icon.style.color = splitModelName(basename)?.type === 'Assembly' ? ASSEMBLY_ACCENT : 'var(--color-primary)';
    }
    const name = document.createElement('span');
    name.className = 'chat-mentions-name';
    name.textContent = basename;
    row.append(icon, name);
    if (slash > 0) {
      const folder = document.createElement('span');
      folder.className = 'chat-mentions-folder';
      folder.textContent = file.path.slice(0, slash);
      row.appendChild(folder);
    }
    row.addEventListener('click', () => this.pick(index));
    return row;
  }

  private syncHighlight(): void {
    for (const [index, row] of this.rows.entries()) {
      const on = index === this.highlighted;
      row.toggleAttribute('data-highlighted', on);
      row.setAttribute('aria-selected', String(on));
    }
    const active = this.rows[this.highlighted];
    if (active) {
      this.deps.textarea.setAttribute('aria-activedescendant', active.id);
    } else {
      this.deps.textarea.removeAttribute('aria-activedescendant');
    }
  }
}
