import { ICON_CUBE, ICON_FILE_CODE, ICON_FOLDER, ICON_PUZZLE, ICON_SLIDERS } from '../ui/icons';
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

/** A row of the list: an existing file to open, or a name to create. */
type Row = { kind: 'open'; file: WorkspaceFileEntry } | { kind: 'create'; target: CreateTarget };

/** The file each offer for a bare name creates, in the order they are listed. */
const CREATE_TYPES: ReadonlyArray<{ type: CreateType; suffix: string; label: string }> = [
  { type: 'part', suffix: '.part.js', label: 'part' },
  { type: 'assembly', suffix: '.assembly.js', label: 'assembly' },
  { type: 'params', suffix: '.params.js', label: 'global params' },
  { type: 'feature', suffix: '.feature.js', label: 'feature' },
];

/** A custom feature module (`*.feature.js`): the server's `FeatureModules.SUFFIX`. */
const FEATURE_SUFFIX = '.feature.js';

/** A global params file (`*.params.js`), the Parameters column's sliders. */
const PARAMS_SUFFIX = '.params.js';

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

/** The list's height before it scrolls: about six two-line rows. */
const LIST_MAX_HEIGHT = 280;

/**
 * An overflow smaller than this — under half a two-line row — grows the list
 * to fit instead of scrolling: a scrollbar that reveals a sliver of one row
 * (six rows ran 1px over the cap) is noise. Past it, a scroll has a row to
 * show, and the row cut at the bottom says there is more.
 */
const LIST_OVERFLOW_SLACK = 24;

/**
 * The mark a Create row's icon wears: a filled plus disc at its lower right,
 * in the icon's own tint, so `Create part` reads as a part that isn't there
 * yet. The outer ring is cut from the row's own background
 * (`--quick-open-row-bg`) to part the disc from the strokes under it.
 */
const CREATE_BADGE =
  '<svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">' +
  '<circle cx="5" cy="5" r="5" fill="var(--quick-open-row-bg)"/>' +
  '<circle cx="5" cy="5" r="3.75" fill="currentColor"/>' +
  '<path d="M5 3.2v3.6M3.2 5h3.6" stroke="var(--quick-open-row-bg)" stroke-width="1.2" stroke-linecap="round"/>' +
  '</svg>';

/** The highlight the arrow keys and the pointer share: the menus' hover tint, as Quick Find's rows wear it. */
const ROW_HIGHLIGHT = ['bg-base-content/[0.08]', 'text-base-content'];
const ROW_RESTING = 'text-base-content/70';

/** A row's background, resting and highlighted, as an opaque color the badge's ring can match. */
const ROW_BG = 'var(--color-base-100)';
const ROW_BG_HIGHLIGHTED = 'color-mix(in srgb, var(--color-base-content) 8%, var(--color-base-100))';

export class QuickOpen {
  private popover: HTMLDivElement | null = null;
  private input: HTMLInputElement | null = null;
  private files: WorkspaceFileEntry[] = [];
  private folders: string[] = [];
  private query = '';
  private highlighted = 0;
  private rows: Row[] = [];
  private rowElements: HTMLElement[] = [];
  /** Where the pointer last moved over the list; a move that lands where it already was is no move. */
  private lastPointer: { x: number; y: number } | null = null;

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
    list.className = 'overflow-y-auto py-1';
    popover.appendChild(list);
    // The pointer over a row highlights it — the one highlight Enter and a
    // click both act on, as in Quick Find. Only a real move counts: a list
    // redrawn under a resting pointer (each keystroke redraws it) must not
    // pull the highlight off the top row the user is about to Enter.
    list.addEventListener('pointermove', (event) => {
      if (this.lastPointer?.x === event.clientX && this.lastPointer.y === event.clientY) {
        return;
      }
      this.lastPointer = { x: event.clientX, y: event.clientY };
      const row = (event.target as Element).closest<HTMLElement>('[data-row-index]');
      const index = row ? Number(row.dataset.rowIndex) : -1;
      if (index >= 0 && index !== this.highlighted) {
        this.highlighted = index;
        this.syncHighlight();
      }
    });

    document.body.appendChild(popover);
    this.popover = popover;
    this.input = input;
    this.query = '';
    this.highlighted = 0;
    this.lastPointer = null;
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
      const total = this.rows.length;
      if (total > 0) {
        const step = event.key === 'ArrowDown' ? 1 : -1;
        this.highlighted = (this.highlighted + step + total) % total;
        this.syncHighlight();
        // The list is capped in height; keep the highlight on screen.
        this.rowElements[this.highlighted]?.scrollIntoView({ block: 'nearest' });
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

  /**
   * Whether the Create rows lead the list. A bare name that is already a
   * part or an assembly is most likely typed to open it, so the matching
   * files stay on top; one that is neither names something new — the
   * near-misses that fuzzy-match it (`desk-box` for `desk`) shouldn't sit
   * between the user and Enter creating it.
   */
  private createFirst(): boolean {
    const name = this.query.trim();
    return !this.files.some((file) =>
      file.path === `${name}.part.js` || file.path === `${name}.assembly.js`);
  }

  private activate(index: number, list: HTMLElement): void {
    const row = this.rows[index];
    if (!row) {
      return;
    }
    if (row.kind === 'open') {
      this.close();
      this.handlers.onOpen(row.file);
      return;
    }
    const target = row.target;
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
    let results: WorkspaceFileEntry[];
    if (this.query.includes('.')) {
      const name = this.query.trim();
      results = this.files.filter((file) => file.path === name);
    } else {
      results = this.files
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

    const opens: Row[] = results.map((file) => ({ kind: 'open', file }));
    const creates: Row[] = this.createTargets().map((target) => ({ kind: 'create', target }));
    this.rows = this.createFirst() ? [...creates, ...opens] : [...opens, ...creates];

    list.replaceChildren();

    const rowElements: HTMLElement[] = [];
    for (const [index, row] of this.rows.entries()) {
      // A rule where opening ends and creating begins (or the other way
      // round), so the two kinds of row read as two groups.
      if (index > 0 && row.kind !== this.rows[index - 1].kind) {
        const divider = document.createElement('div');
        divider.setAttribute('role', 'separator');
        divider.className = 'mx-3 my-1.5 border-t border-base-content/20';
        list.appendChild(divider);
      }
      const onPick = (): void => this.activate(index, list);
      let element: HTMLElement;
      if (row.kind === 'create') {
        element = this.buildRow({ ...QuickOpen.describeCreate(row.target), onPick });
      } else {
        const basename = row.file.path.split('/').pop() || row.file.path;
        element = this.buildRow({
          icon: QuickOpen.buildIcon(QuickOpen.fileIcon(row.file.kind, basename), basename),
          label: basename,
          detail: row.file.path,
          onPick,
        });
      }
      element.dataset.rowIndex = String(index);
      rowElements.push(element);
      list.appendChild(element);
    }
    this.rowElements = rowElements;
    this.syncHighlight();

    if (this.rows.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'px-3 py-2 text-xs text-base-content/40';
      const name = this.query.trim();
      const folder = name.endsWith('/') && this.folders.includes(name.replace(/\/+$/, '')) ? name : null;
      empty.textContent = folder
        ? `Type a name to create a file in ${folder}`
        : this.files.length === 0 ? 'No files in this workspace.' : 'No matches.';
      list.appendChild(empty);
    }

    QuickOpen.fitHeight(list);
    // A capped list can have the highlight scrolled out of sight; keep it on screen.
    rowElements[this.highlighted]?.scrollIntoView({ block: 'nearest' });
  }

  /**
   * Cap the list at {@link LIST_MAX_HEIGHT} only when its rows run past it by
   * more than {@link LIST_OVERFLOW_SLACK}; short of that it grows to fit, so a
   * scrollbar shows only when there is a row to scroll to.
   */
  private static fitHeight(list: HTMLElement): void {
    list.style.maxHeight = '';
    const fits = list.scrollHeight <= LIST_MAX_HEIGHT + LIST_OVERFLOW_SLACK;
    list.style.maxHeight = fits ? '' : `${LIST_MAX_HEIGHT}px`;
  }

  /** Paint the highlight onto its row, in place: the pointer moves it without a redraw. */
  private syncHighlight(): void {
    for (const [index, row] of this.rowElements.entries()) {
      const on = index === this.highlighted;
      row.classList.toggle(ROW_RESTING, !on);
      for (const name of ROW_HIGHLIGHT) {
        row.classList.toggle(name, on);
      }
      row.style.setProperty('--quick-open-row-bg', on ? ROW_BG_HIGHLIGHTED : ROW_BG);
    }
  }

  /**
   * A listed file's icon: a model's cube, a feature module's puzzle piece, a
   * global params file's sliders, a plain module's file.
   */
  private static fileIcon(kind: FileKind, basename: string): string {
    if (kind === 'model') {
      return ICON_CUBE;
    }
    if (basename.endsWith(FEATURE_SUFFIX)) {
      return ICON_PUZZLE;
    }
    return basename.endsWith(PARAMS_SUFFIX) ? ICON_SLIDERS : ICON_FILE_CODE;
  }

  /**
   * The icon a Create offer's row wears: the file's own, as {@link fileIcon}
   * draws it once it exists — a name typed with its extension included, by
   * the suffix it ends in.
   */
  private static createIcon(target: CreateTarget): string {
    if (target.kind === 'folder') {
      return ICON_FOLDER;
    }
    const type = target.type ?? CREATE_TYPES.find(({ suffix }) => target.path.endsWith(suffix))?.type;
    switch (type) {
      case 'part':
      case 'assembly':
        return ICON_CUBE;
      case 'params':
        return ICON_SLIDERS;
      case 'feature':
        return ICON_PUZZLE;
      default:
        return ICON_FILE_CODE;
    }
  }

  /**
   * A Create row's icon and wording. A typed bare name reads as the kind of
   * file it makes — `Create part "bracket"` under its cube, the assembly's in
   * teal, global params under the Parameters column's sliders, a feature
   * under a puzzle piece — with the file name it lands as underneath. Every
   * Create row's icon carries the plus badge, so it reads as new at a glance.
   */
  private static describeCreate(target: CreateTarget): { icon: HTMLElement; label: string | Node; detail?: string } {
    const basename = target.path.split('/').pop() || target.path;
    const icon = QuickOpen.buildIcon(QuickOpen.createIcon(target), target.kind === 'file' ? basename : undefined, true);
    if (target.kind === 'folder') {
      return { icon, label: `Create folder ${target.path}/` };
    }
    const offer = CREATE_TYPES.find((entry) => entry.type === target.type);
    if (!offer) {
      return { icon, label: `Create ${target.path}` };
    }
    const stem = basename.slice(0, -offer.suffix.length);
    const kind = document.createElement('strong');
    kind.className = 'font-semibold';
    kind.textContent = offer.label;
    const label = document.createDocumentFragment();
    label.append('Create ', kind, ` "${stem}"`);
    return { icon, label, detail: target.path };
  }

  /**
   * A row's icon, tinted by the kind of file: a part's cube in the theme's
   * primary blue and an assembly's in the assembly teal, as the file tabs
   * tint theirs; a global params file's sliders in the accent green the
   * expression suggestions' G (project parameter) chip wears; a feature
   * module's puzzle piece in the feature violet; anything else, a folder
   * included, in the quiet gray everything else here uses. `create` adds the
   * plus badge.
   */
  private static buildIcon(svg: string, basename?: string, create = false): HTMLElement {
    const icon = document.createElement('span');
    icon.className = 'relative shrink-0 [&>svg]:size-3.5';
    icon.innerHTML = svg;
    if (create) {
      const badge = document.createElement('span');
      badge.className = 'absolute -right-[3px] -bottom-[3px] flex';
      badge.innerHTML = CREATE_BADGE;
      icon.appendChild(badge);
    }
    icon.classList.add(QuickOpen.iconTint(basename));
    if (basename !== undefined && splitModelName(basename)?.type === 'Assembly') {
      icon.style.color = ASSEMBLY_ACCENT;
    }
    return icon;
  }

  /** The text colour class an icon takes for its file's name; an assembly's teal is set inline over it. */
  private static iconTint(basename: string | undefined): string {
    if (basename === undefined) {
      return 'text-base-content/40';
    }
    if (splitModelName(basename)?.type === 'Part') {
      return 'text-primary';
    }
    if (basename.endsWith(PARAMS_SUFFIX)) {
      return 'text-accent';
    }
    if (basename.endsWith(FEATURE_SUFFIX)) {
      return 'text-feature';
    }
    return 'text-base-content/40';
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
    onPick: () => void;
  }): HTMLElement {
    const row = document.createElement('button');
    row.className = 'w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm cursor-pointer';
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
