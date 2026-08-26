import { ICON_CUBE, ICON_FILE_CODE, ICON_PLUS } from '../ui/icons';
import { listWorkspaceFiles, type FileKind, type WorkspaceFileEntry } from './editor-api';

/**
 * The `+` picker: a fuzzy filter over the workspace's source files, plus an
 * offer to create a name that doesn't exist yet. This is the whole
 * file-opening surface — there is no tree
 * (`docs/desktop/05-editor-surface-design.md`).
 *
 * Deliberately workspace-only. The spec floated a "Browse…" row for files
 * outside the workspace; dropped (2026-08-15) — `/api/files/*` enforces a
 * workspace boundary on purpose, and a model importing an outside file
 * wouldn't resolve through Vite's workspace root anyway.
 *
 * Built on the dropdown idiom `timeline-panel.ts` and `shapes-panel.ts`
 * already use, rather than a third popover style.
 */

export interface QuickOpenHandlers {
  /** Open an existing workspace file as a tab. */
  onOpen(entry: { path: string; absPath: string; kind: FileKind }): void;
  /** Create `relPath` and open it. */
  onCreate(relPath: string): void;
}

/** Subsequence match — the same shape of matching every quick-open uses. */
function fuzzyScore(candidate: string, query: string): number | null {
  if (query === '') {
    return 0;
  }
  const haystack = candidate.toLowerCase();
  const needle = query.toLowerCase();

  let score = 0;
  let from = 0;
  let previous = -2;
  for (const char of needle) {
    const at = haystack.indexOf(char, from);
    if (at === -1) {
      return null;
    }
    // Adjacent characters, and matches right after a path separator, are what
    // the user was actually aiming at.
    if (at === previous + 1) {
      score -= 2;
    }
    if (at === 0 || haystack[at - 1] === '/' || haystack[at - 1] === '.') {
      score -= 3;
    }
    score += at - from;
    previous = at;
    from = at + 1;
  }
  return score;
}

const MAX_RESULTS = 12;

export class QuickOpen {
  private popover: HTMLDivElement | null = null;
  private files: WorkspaceFileEntry[] = [];
  private query = '';
  private highlighted = 0;
  private results: WorkspaceFileEntry[] = [];

  constructor(private readonly handlers: QuickOpenHandlers) {}

  isOpen(): boolean {
    return this.popover !== null;
  }

  close(): void {
    this.popover?.remove();
    this.popover = null;
    document.removeEventListener('pointerdown', this.onDocumentPointerDown, true);
  }

  async open(anchor: HTMLElement): Promise<void> {
    if (this.popover) {
      this.close();
      return;
    }

    const popover = document.createElement('div');
    // Opaque for the same reason as the top bar's menu: anchored under `+`, it
    // drops over the Navbar's icon row, and a translucent surface lets those
    // buttons read through the file list.
    popover.className =
      'fixed z-[200] w-[340px] bg-base-100 border border-base-content/10 rounded-md ' +
      'shadow-[0_4px_12px_rgba(0,0,0,0.4)] overflow-hidden';
    const rect = anchor.getBoundingClientRect();
    popover.style.top = `${rect.bottom + 4}px`;
    popover.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 348))}px`;

    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Open or create a file…';
    input.className =
      'w-full bg-transparent px-3 py-2 text-sm outline-none ' +
      'border-b border-base-content/10 placeholder:text-base-content/40';
    popover.appendChild(input);

    const list = document.createElement('div');
    list.className = 'max-h-[280px] overflow-y-auto py-1';
    popover.appendChild(list);

    document.body.appendChild(popover);
    this.popover = popover;
    this.query = '';
    this.highlighted = 0;
    document.addEventListener('pointerdown', this.onDocumentPointerDown, true);

    input.addEventListener('input', () => {
      this.query = input.value;
      this.highlighted = 0;
      this.renderResults(list);
    });
    input.addEventListener('keydown', (event) => this.onKeyDown(event, list));
    input.focus();

    this.renderResults(list); // Something to look at while the listing loads.
    try {
      const { files } = await listWorkspaceFiles();
      this.files = files.filter((file) => file.kind !== 'other');
    } catch {
      this.files = [];
    }
    if (this.popover === popover) {
      this.renderResults(list);
    }
  }

  private readonly onDocumentPointerDown = (event: PointerEvent): void => {
    if (this.popover && !this.popover.contains(event.target as Node)) {
      this.close();
    }
  };

  private onKeyDown(event: KeyboardEvent, list: HTMLElement): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.close();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const total = this.results.length + (this.createTarget() ? 1 : 0);
      if (total > 0) {
        const step = event.key === 'ArrowDown' ? 1 : -1;
        this.highlighted = (this.highlighted + step + total) % total;
        this.renderResults(list);
      }
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      this.activate(this.highlighted);
    }
  }

  /**
   * A query that names a file which doesn't exist is an offer to create it —
   * file creation lives here rather than in a separate dialog.
   */
  private createTarget(): string | null {
    const name = this.query.trim();
    if (name === '' || name.endsWith('/')) {
      return null;
    }
    if (this.files.some((file) => file.path === name)) {
      return null;
    }
    return /\.[a-z0-9]+$/i.test(name) ? name : `${name}.fluid.js`;
  }

  private activate(index: number): void {
    const entry = this.results[index];
    if (entry) {
      this.close();
      this.handlers.onOpen(entry);
      return;
    }
    const target = this.createTarget();
    if (target && index === this.results.length) {
      this.close();
      this.handlers.onCreate(target);
    }
  }

  private renderResults(list: HTMLElement): void {
    this.results = this.files
      .map((file) => ({ file, score: fuzzyScore(file.path, this.query) }))
      .filter((row): row is { file: WorkspaceFileEntry; score: number } => row.score !== null)
      // Models before helpers, then by match quality: opening a part is the
      // common case and a model should not lose to a same-named helper.
      .sort((a, b) =>
        (a.file.kind === b.file.kind ? 0 : a.file.kind === 'model' ? -1 : 1) ||
        a.score - b.score ||
        a.file.path.localeCompare(b.file.path))
      .slice(0, MAX_RESULTS)
      .map((row) => row.file);

    list.replaceChildren();

    for (const [index, file] of this.results.entries()) {
      list.appendChild(this.buildRow({
        icon: file.kind === 'model' ? ICON_CUBE : ICON_FILE_CODE,
        label: file.path,
        highlighted: index === this.highlighted,
        onPick: () => this.activate(index),
      }));
    }

    const createTarget = this.createTarget();
    if (createTarget) {
      list.appendChild(this.buildRow({
        icon: ICON_PLUS,
        label: `Create ${createTarget}`,
        highlighted: this.highlighted === this.results.length,
        onPick: () => this.activate(this.results.length),
      }));
    }

    if (this.results.length === 0 && !createTarget) {
      const empty = document.createElement('div');
      empty.className = 'px-3 py-2 text-xs text-base-content/40';
      empty.textContent = this.files.length === 0 ? 'No files in this workspace.' : 'No matches.';
      list.appendChild(empty);
    }
  }

  private buildRow(options: {
    icon: string;
    label: string;
    highlighted: boolean;
    onPick: () => void;
  }): HTMLElement {
    const row = document.createElement('button');
    row.className =
      'w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm ' +
      (options.highlighted ? 'bg-base-content/10 text-base-content' : 'text-base-content/70');
    row.innerHTML =
      `<span class="shrink-0 text-base-content/40 [&>svg]:size-3.5">${options.icon}</span>` +
      `<span class="truncate"></span>`;
    row.querySelector('span:last-child')!.textContent = options.label;
    row.addEventListener('click', options.onPick);
    return row;
  }
}
