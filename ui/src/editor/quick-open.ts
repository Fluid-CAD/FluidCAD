import { ICON_CUBE, ICON_FILE_CODE, ICON_FOLDER_PLUS, ICON_PLUS, ICON_PUZZLE, ICON_SLIDERS } from '../ui/icons';
import { listWorkspaceFiles, type FileKind, type WorkspaceFileEntry } from './editor-api';
import { ASSEMBLY_ACCENT, splitModelName } from './model-name';

/**
 * The `+` picker: a fuzzy filter over the workspace's source files, plus an
 * offer to create a name that doesn't exist yet. This is the whole
 * file-opening surface — there is no tree
 * (`docs/desktop/05-editor-surface-design.md`).
 *
 * Deliberately workspace-only. The spec floated a "Browse…" row for files
 * outside the workspace; dropped (2026-08-15) — `api/files/*` enforces a
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
  /** Create the folder `relPath`; resolves once it exists on disk. */
  onCreateFolder(relPath: string): Promise<void>;
}

/**
 * What the query offers to create when nothing answers to it yet. A bare
 * name is offered as each kind of file a project is made of — `type` says
 * which — while a name spelled with its extension is created as typed.
 */
type CreateTarget = { kind: 'file' | 'folder'; path: string; type?: CreateType };

type CreateType = 'part' | 'assembly' | 'params' | 'feature';

/** The file each offer for a bare name creates, in the order they are listed. */
const CREATE_TYPES: ReadonlyArray<{ type: CreateType; suffix: string; label: string }> = [
  { type: 'part', suffix: '.part.js', label: 'part' },
  { type: 'assembly', suffix: '.assembly.js', label: 'assembly' },
  { type: 'params', suffix: '.params.js', label: 'global params' },
  { type: 'feature', suffix: '.feature.js', label: 'feature' },
];

/** A custom feature module (`*.feature.js`): the server's `FeatureModules.SUFFIX`. */
const FEATURE_SUFFIX = '.feature.js';

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
  private input: HTMLInputElement | null = null;
  private files: WorkspaceFileEntry[] = [];
  private folders: string[] = [];
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
    this.input = null;
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
    this.input = input;
    this.query = '';
    this.highlighted = 0;
    document.addEventListener('pointerdown', this.onDocumentPointerDown, true);

    input.addEventListener('input', () => {
      // Paths are workspace-relative, so a leading slash means nothing here —
      // drop it as typed rather than offering to create "/x".
      if (input.value.startsWith('/')) {
        input.value = input.value.replace(/^\/+/, '');
      }
      this.query = input.value;
      this.highlighted = 0;
      this.renderResults(list);
    });
    input.addEventListener('keydown', (event) => this.onKeyDown(event, list));
    input.focus();

    this.renderResults(list); // Something to look at while the listing loads.
    try {
      const { files, folders } = await listWorkspaceFiles();
      this.files = files.filter((file) => file.kind !== 'other');
      this.folders = folders;
    } catch {
      this.files = [];
      this.folders = [];
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
      const total = this.results.length + this.createTargets().length;
      if (total > 0) {
        const step = event.key === 'ArrowDown' ? 1 : -1;
        this.highlighted = (this.highlighted + step + total) % total;
        this.renderResults(list);
      }
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      this.activate(this.highlighted, list);
    }
  }

  /**
   * A query that names something which doesn't exist is an offer to create
   * it — creation lives here rather than in a separate dialog. A trailing
   * slash names a folder; a name with an extension the file it spells; a bare
   * name a part, an assembly or a global params file of that name, minus any
   * that already exist. `a/b` lands in folder `a` (created on the way if need
   * be).
   */
  private createTargets(): CreateTarget[] {
    const name = this.query.trim();
    if (name === '') {
      return [];
    }
    if (name.endsWith('/')) {
      const folder = name.replace(/\/+$/, '');
      if (folder === '' || this.folders.includes(folder)) {
        return [];
      }
      return [{ kind: 'folder', path: folder }];
    }
    const targets: CreateTarget[] = /\.[a-z0-9]+$/i.test(name)
      ? [{ kind: 'file', path: name }]
      : CREATE_TYPES.map(({ type, suffix }) => ({ kind: 'file', path: `${name}${suffix}`, type }));
    return targets.filter((target) => !this.files.some((file) => file.path === target.path));
  }

  private activate(index: number, list: HTMLElement): void {
    const entry = this.results[index];
    if (entry) {
      this.close();
      this.handlers.onOpen(entry);
      return;
    }
    const target = this.createTargets()[index - this.results.length];
    if (!target) {
      return;
    }
    if (target.kind === 'file') {
      this.close();
      this.handlers.onCreate(target.path);
      return;
    }
    // A folder is somewhere to put a file, so the picker stays open with the
    // folder typed in: the next keystrokes name the file inside it.
    void this.createFolder(target.path, list);
  }

  private async createFolder(folder: string, list: HTMLElement): Promise<void> {
    const popover = this.popover;
    try {
      await this.handlers.onCreateFolder(folder);
    } catch {
      return;
    }
    if (this.popover !== popover) {
      return;
    }
    // `a/b/c` brought `a` and `a/b` into being too; every prefix now exists.
    const segments = folder.split('/');
    for (let depth = 1; depth <= segments.length; depth++) {
      const prefix = segments.slice(0, depth).join('/');
      if (!this.folders.includes(prefix)) {
        this.folders.push(prefix);
      }
    }
    this.highlighted = 0;
    this.renderResults(list);
    // A click on the row took focus; the next keystrokes belong in the input.
    this.input?.focus();
  }

  private renderResults(list: HTMLElement): void {
    // A dot means the user is spelling out a file name, not filtering: offer
    // only Create — except a name an existing file already answers to, which
    // shows that file so a fully typed name still opens it.
    if (this.query.includes('.')) {
      const name = this.query.trim();
      this.results = this.files.filter((file) => file.path === name);
    } else {
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
    }

    list.replaceChildren();

    for (const [index, file] of this.results.entries()) {
      const basename = file.path.split('/').pop() || file.path;
      list.appendChild(this.buildRow({
        icon: QuickOpen.buildIcon(QuickOpen.fileIcon(file.kind, basename), basename),
        label: basename,
        detail: file.path,
        highlighted: index === this.highlighted,
        onPick: () => this.activate(index, list),
      }));
    }

    const createTargets = this.createTargets();
    for (const [offset, target] of createTargets.entries()) {
      const index = this.results.length + offset;
      list.appendChild(this.buildRow({
        ...QuickOpen.describeCreate(target),
        highlighted: this.highlighted === index,
        onPick: () => this.activate(index, list),
      }));
    }

    // The list is capped in height, so an arrow-key highlight can land on a
    // row the popover has scrolled out of sight; keep it on screen.
    (list.children[this.highlighted] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' });

    if (this.results.length === 0 && createTargets.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'px-3 py-2 text-xs text-base-content/40';
      const name = this.query.trim();
      const folder = name.endsWith('/') && this.folders.includes(name.replace(/\/+$/, '')) ? name : null;
      empty.textContent = folder
        ? `Type a name to create a file in ${folder}`
        : this.files.length === 0 ? 'No files in this workspace.' : 'No matches.';
      list.appendChild(empty);
    }
  }

  /** A listed file's icon: a model's cube, a feature module's puzzle piece, a plain module's file. */
  private static fileIcon(kind: FileKind, basename: string): string {
    if (kind === 'model') {
      return ICON_CUBE;
    }
    return basename.endsWith(FEATURE_SUFFIX) ? ICON_PUZZLE : ICON_FILE_CODE;
  }

  /** The icon a Create offer's row wears: the file's own, as {@link fileIcon} draws it once it exists. */
  private static createIcon(type: CreateType): string {
    switch (type) {
      case 'params':
        return ICON_SLIDERS;
      case 'feature':
        return ICON_PUZZLE;
      default:
        return ICON_CUBE;
    }
  }

  /**
   * A Create row's icon and wording. A typed bare name reads as the kind of
   * file it makes — `Create part "bracket"` under its cube, the assembly's in
   * teal, global params under the Parameters column's sliders, a feature
   * under a puzzle piece — with the file name it lands as underneath.
   */
  private static describeCreate(target: CreateTarget): { icon: HTMLElement; label: string | Node; detail?: string } {
    if (target.kind === 'folder') {
      return { icon: QuickOpen.buildIcon(ICON_FOLDER_PLUS), label: `Create folder ${target.path}/` };
    }
    const offer = CREATE_TYPES.find((entry) => entry.type === target.type);
    if (!offer) {
      return { icon: QuickOpen.buildIcon(ICON_PLUS), label: `Create ${target.path}` };
    }
    const basename = target.path.split('/').pop() || target.path;
    const stem = basename.slice(0, -offer.suffix.length);
    const kind = document.createElement('strong');
    kind.className = 'font-semibold';
    kind.textContent = offer.label;
    const label = document.createDocumentFragment();
    label.append('Create ', kind, ` "${stem}"`);
    return {
      icon: QuickOpen.buildIcon(QuickOpen.createIcon(offer.type), basename),
      label,
      detail: target.path,
    };
  }

  /**
   * A row's icon, tinted the way the file tabs tint theirs: a part's cube in
   * the theme's primary blue, an assembly's in the assembly teal, and a helper
   * (or the Create row's plus) in the quiet gray everything else here uses.
   */
  private static buildIcon(svg: string, basename?: string): HTMLElement {
    const icon = document.createElement('span');
    icon.className = 'shrink-0 [&>svg]:size-3.5';
    icon.innerHTML = svg;
    const model = basename === undefined ? null : splitModelName(basename);
    if (model?.type === 'Assembly') {
      icon.style.color = ASSEMBLY_ACCENT;
    } else {
      icon.classList.add(model?.type === 'Part' ? 'text-primary' : 'text-base-content/40');
    }
    return icon;
  }

  /**
   * One result row: the label, with an optional second line underneath for
   * the workspace-relative path — file rows read as name-over-path so a name
   * is scannable and the path still disambiguates same-named files.
   */
  private buildRow(options: {
    icon: HTMLElement;
    label: string | Node;
    detail?: string;
    highlighted: boolean;
    onPick: () => void;
  }): HTMLElement {
    const row = document.createElement('button');
    row.className =
      'w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm ' +
      (options.highlighted ? 'bg-base-content/10 text-base-content' : 'text-base-content/70');
    row.appendChild(options.icon);

    const text = document.createElement('span');
    text.className = 'min-w-0 flex flex-col leading-tight';
    row.appendChild(text);

    const label = document.createElement('span');
    label.className = 'truncate';
    label.append(options.label);
    text.appendChild(label);

    if (options.detail !== undefined) {
      const detail = document.createElement('span');
      detail.className = 'truncate text-xs text-base-content/50';
      detail.textContent = options.detail;
      text.appendChild(detail);
    }

    row.addEventListener('click', options.onPick);
    return row;
  }
}
