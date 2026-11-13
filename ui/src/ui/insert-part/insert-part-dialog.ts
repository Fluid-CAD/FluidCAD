import {
  getPartCatalogFiles,
  getScopeVariables,
  type NewVariable,
  insertCatalogParts,
  scanPartCatalogFile,
  type CatalogConfiguration,
  type CatalogEntryKind,
  type CatalogFileEntry,
  type CatalogInsertRequest,
  type CatalogParamDef,
  type CatalogScanResult,
} from '../../api';
import { ICON_CLOSE } from '../icons';
import type { VariableInfo } from '../expression-core';
import { collectNewVariablesChecked } from '../expression-field';
import { ParamForm } from '../param-controls';
import { PartThumbnailRenderer } from './part-thumbnails';
import { sceneUnit } from '../../units/scene-unit';
import type { LengthUnit } from '../../units/units';
import { GeneratedDefinition } from '../../interactive/generated/generated-definition';

type CatalogFilter = 'all' | 'parts' | 'assemblies';

/** The reserved row: the `param()` literals — an insert that names no row. */
const DEFAULT_CONFIGURATION = 'Default';

/** Long names for the unit badge's tooltip. */
const UNIT_NAMES: Record<LengthUnit, string> = {
  mm: 'millimeters',
  cm: 'centimeters',
  m: 'meters',
  in: 'inches',
  ft: 'feet',
};

/** One queued instance — tile clicks append these, Insert commits them all. */
type BasketEntry = {
  key: string;
  file: CatalogFileEntry;
  exportName: string;
  kind: CatalogEntryKind;
  displayName: string;
  params: CatalogParamDef[];
  /** The definition's `configurations()` rows; empty without a table. */
  configurations: CatalogConfiguration[];
  /** The row this instance inserts with — `Default` for the literals. */
  configuration: string;
  thumb: string | null;
  /** Built when the params step first shows this entry; values survive paging. */
  form: ParamForm | null;
};

/** Per-tile visit state behind the corner badge. */
type TileState = {
  key: string;
  badge: HTMLSpanElement;
  minus: HTMLButtonElement;
  queued: number;
};

/** One carousel step: a distinct part and every queued instance of it. */
type PageGroup = {
  key: string;
  displayName: string;
  filePath: string;
  thumb: string | null;
  entries: BasketEntry[];
};

/**
 * The assembly toolbar's Insert dialog — a two-step wizard.
 *
 * Step 1 (select): one grid of every insertable part and sub-assembly in the
 * workspace, one tile each with a thumbnail and the defining file as its
 * caption. Candidate files come from the catalog's cheap prefilter; each is
 * then scanned server-side in turn (evaluation shares the OCC mutex with
 * renders, so sequential requests add no latency) and its tiles pop into the
 * grid as results land. Clicking a tile QUEUES one instance (click again for
 * more; hover reveals a − to remove); the footer button advances. Library
 * packages the project doesn't pin yet stay unscanned and out of the grid
 * until the Show library parts toggle is on.
 *
 * Step 2 (parameters): one carousel page per queued instance that declares
 * `param()`s — two queued extrusions can get different lengths in one pass —
 * with a form rendered from the scanned definitions. Paramless entries skip
 * the step entirely (the footer button reads "Insert N" straight away). Prev
 * steps back a page, and from the first page back to the grid.
 *
 * Insert commits the whole basket as ONE batch edit: one editor round trip,
 * one re-render, statement per instance — then the dialog closes, letting
 * the new instances take the stage in the viewport. A failed commit stays
 * open on the grid with the reason in the status line.
 *
 * Everything reloads on every open: unchanged files answer from the server's
 * mtime-keyed scan cache, so freshness costs one round-trip per file, not a
 * re-evaluation.
 *
 * A generated part or assembly (`definePart`, `defineAssembly`) is listed
 * from its schema, never built: its tile shows its icon, and a click opens
 * its own dialog ({@link onGenerated}: values with a live preview) instead
 * of queueing it — the dialog closes for it, so a click with instances
 * queued says so and opens nothing.
 */
export class InsertPartDialog {
  /** A generated tile was clicked with nothing queued: open the definition's dialog. */
  onGenerated?: (definition: GeneratedDefinition) => void;

  private overlay: HTMLDivElement;
  private gridEl: HTMLDivElement;
  private statusEl: HTMLDivElement;
  private selectStepEl: HTMLDivElement;
  private paramsStepEl: HTMLDivElement;
  private pageHostEl: HTMLDivElement;
  private pagePosEl: HTMLSpanElement;
  private nextBtn: HTMLButtonElement;
  private prevPageBtn: HTMLButtonElement;
  private nextPageBtn: HTMLButtonElement;
  private thumbs = new PartThumbnailRenderer();
  private abort: AbortController | null = null;
  private inserting = false;
  private variables: VariableInfo[] = [];
  /** Sticky across opens — reset only by the user clicking another chip. */
  private filter: CatalogFilter = 'all';
  /**
   * Sticky across opens like the filter: library packages' files (offered
   * by the library, not pinned by the project) are scanned and shown only
   * while this is on.
   */
  private showLibrary = false;
  /** The open assembly file — its own entries are excluded from the grid. */
  private excludeAbsPath: string | null = null;

  /** Every candidate file of this load, scanned or not. */
  private files: CatalogFileEntry[] = [];
  /** Files waiting for their scan, in order — the pump drains it. */
  private pending: CatalogFileEntry[] = [];
  /** Files queued, in flight or done this load, by absolute path. */
  private scheduled = new Set<string>();
  /** The load whose pump is draining `pending`; null while idle. */
  private pumpOwner: AbortController | null = null;
  private scannedCount = 0;
  private failures: { file: CatalogFileEntry; text: string }[] = [];
  private skipped: { file: CatalogFileEntry; text: string }[] = [];

  private basket: BasketEntry[] = [];
  private tiles = new Map<string, TileState>();
  /** The grids by source ('' for the workspace, `name@version` for a package), each with its heading. */
  private groups = new Map<string, { pkg: CatalogFileEntry['package'] | null; heading: HTMLDivElement; grid: HTMLDivElement }>();
  /** The "From library" section heading above the library packages' groups. */
  private libraryHeading = InsertPartDialog.libraryHeading();
  /** One page per DISTINCT parameterized part; its queued instances are the page's rows. */
  private pages: PageGroup[] = [];
  private pageIndex = 0;

  constructor(container: HTMLElement) {
    this.overlay = document.createElement('div');
    this.overlay.className = 'fixed inset-0 z-[300] bg-black/50 flex items-center justify-center hidden';
    this.overlay.innerHTML = this.buildHTML();
    container.appendChild(this.overlay);

    this.gridEl = this.overlay.querySelector('[data-ref="tree"]')!;
    this.statusEl = this.overlay.querySelector('[data-ref="status"]')!;
    this.selectStepEl = this.overlay.querySelector('[data-ref="step-select"]')!;
    this.paramsStepEl = this.overlay.querySelector('[data-ref="step-params"]')!;
    this.pageHostEl = this.overlay.querySelector('[data-ref="page-host"]')!;
    this.pagePosEl = this.overlay.querySelector('[data-ref="page-pos"]')!;
    this.nextBtn = this.overlay.querySelector('[data-ref="next-btn"]')!;
    this.prevPageBtn = this.overlay.querySelector('[data-ref="prev-page"]')!;
    this.nextPageBtn = this.overlay.querySelector('[data-ref="next-page"]')!;

    this.overlay.querySelector('[data-ref="close-btn"]')!.addEventListener('click', () => this.hide());
    this.overlay.querySelector('[data-ref="refresh-btn"]')!.addEventListener('click', () => void this.load());
    this.nextBtn.addEventListener('click', () => void this.advance());
    this.prevPageBtn.addEventListener('click', () => this.pageBack());
    this.nextPageBtn.addEventListener('click', () => void this.pageForward());
    const libraryToggle = this.overlay.querySelector<HTMLInputElement>('[data-ref="show-library"]')!;
    libraryToggle.addEventListener('change', () => this.setShowLibrary(libraryToggle.checked));
    this.overlay.querySelectorAll<HTMLInputElement>('input[name="insert-filter"]').forEach(chip => {
      chip.addEventListener('change', () => {
        this.filter = chip.dataset.filter as CatalogFilter;
        this.applyFilter();
      });
    });
    this.overlay.addEventListener('mousedown', (e) => {
      if (e.target === this.overlay) {
        this.hide();
      }
    });
    document.addEventListener('keydown', (e) => {
      // A dialog that has left the document keeps no hold on the keyboard.
      if (e.key === 'Escape' && this.overlay.isConnected && !this.overlay.classList.contains('hidden')) {
        e.stopPropagation();
        this.hide();
      }
    });
  }

  show(currentAbsPath: string | null = null): void {
    this.excludeAbsPath = currentAbsPath;
    this.overlay.classList.remove('hidden');
    this.showSelectStep();
    void this.load();
  }

  hide(): void {
    this.abort?.abort();
    this.abort = null;
    this.inserting = false;
    this.thumbs.dispose();
    this.basket.forEach(entry => entry.form?.destroy());
    this.basket = [];
    this.pages = [];
    this.overlay.classList.add('hidden');
  }

  private buildHTML(): string {
    return `
      <div class="w-[680px] max-w-[92vw] h-[78vh] bg-base-100 border border-base-content/10 rounded-lg p-5 shadow-[0_4px_24px_rgba(0,0,0,0.5)] flex flex-col">
        <div class="flex items-center justify-between mb-3">
          <h3 data-ref="title" class="text-sm font-medium text-base-content/90">Insert part</h3>
          <div class="flex items-center gap-1">
            <button data-ref="refresh-btn" class="btn btn-ghost btn-xs text-base-content/60">Refresh</button>
            <button data-ref="close-btn" class="btn btn-ghost btn-square btn-xs text-base-content/60">
              <span class="[&>svg]:size-4">${ICON_CLOSE}</span>
            </button>
          </div>
        </div>
        <div data-ref="step-select" class="flex flex-col flex-1 min-h-0">
          <div class="flex items-center gap-2 mb-2">
            <input class="btn btn-xs rounded-full border border-base-content/15 checked:btn-primary" type="radio"
              name="insert-filter" data-filter="all" aria-label="All" checked />
            <input class="btn btn-xs rounded-full border border-base-content/15 checked:btn-primary" type="radio"
              name="insert-filter" data-filter="parts" aria-label="Parts" />
            <input class="btn btn-xs rounded-full border border-base-content/15 checked:btn-primary" type="radio"
              name="insert-filter" data-filter="assemblies" aria-label="Assemblies" />
            <label class="ml-auto flex items-center gap-2 cursor-pointer"
              title="Also list the parts of packages in your library that this project doesn't use yet">
              <span class="text-xs text-base-content/70">Show library parts</span>
              <input type="checkbox" data-ref="show-library" class="toggle toggle-xs toggle-primary" />
            </label>
          </div>
          <div data-ref="status" class="text-xs text-base-content/50 mb-2 min-h-4"></div>
          <div data-ref="tree" class="overflow-y-auto flex-1 flex flex-col gap-1 content-start"></div>
          <div class="flex items-center justify-between pt-3">
            <span data-ref="queued-note" class="text-xs text-base-content/50"></span>
            <button data-ref="next-btn" class="btn btn-primary btn-sm" disabled aria-label="Continue">Insert</button>
          </div>
        </div>
        <div data-ref="step-params" class="hidden flex-col flex-1 min-h-0">
          <div data-ref="page-host" class="overflow-y-auto flex-1"></div>
          <div class="flex items-center justify-between pt-3">
            <span data-ref="page-pos" class="text-xs text-base-content/50"></span>
            <div class="flex items-center gap-2">
              <button data-ref="prev-page" class="btn btn-ghost btn-sm" aria-label="Previous">‹ Prev</button>
              <button data-ref="next-page" class="btn btn-primary btn-sm" aria-label="Next">Next ›</button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  private setStatus(text: string, isError = false, tooltip = ''): void {
    this.statusEl.textContent = text;
    this.statusEl.title = tooltip;
    this.statusEl.classList.toggle('text-error', isError);
    this.statusEl.classList.toggle('text-base-content/50', !isError);
  }

  private async load(): Promise<void> {
    if (this.inserting) return;
    this.showSelectStep();
    this.abort?.abort();
    const ac = new AbortController();
    this.abort = ac;
    this.inserting = false;
    this.gridEl.innerHTML = '';
    this.groups.clear();
    this.tiles.clear();
    this.basket.forEach(entry => entry.form?.destroy());
    this.basket = [];
    this.pages = [];
    this.files = [];
    this.pending = [];
    this.scheduled.clear();
    this.scannedCount = 0;
    this.failures = [];
    this.skipped = [];
    this.pageHostEl.replaceChildren();
    this.updateFooter();
    this.setStatus('Looking for part files…');

    const [allFiles, variables] = await Promise.all([
      getPartCatalogFiles(ac.signal),
      getScopeVariables(null, 'assembly').catch(() => []),
    ]);
    if (ac.signal.aborted) {
      return;
    }
    this.variables = variables;
    if (allFiles === null) {
      this.setStatus('Could not reach the FluidCAD server.', true);
      return;
    }
    // The open assembly can't be inserted into itself — drop its file.
    this.files = allFiles.filter(f => f.absPath !== this.excludeAbsPath);
    if (this.files.length === 0) {
      this.setStatus('No other part or assembly files in this workspace.');
      return;
    }
    this.schedule(this.files.filter(file => this.showLibrary || !InsertPartDialog.isLibrary(file)));
    await this.pump(ac);
  }

  /** A file of a package the library offers but the project doesn't pin. */
  private static isLibrary(file: CatalogFileEntry): boolean {
    return file.package?.availability === 'library';
  }

  /** Whether a file's tiles (and its scan problems) are in view under the toggle. */
  private visibleFile(file: CatalogFileEntry): boolean {
    return this.showLibrary || !InsertPartDialog.isLibrary(file);
  }

  private schedule(files: CatalogFileEntry[]): void {
    for (const file of files) {
      if (!this.scheduled.has(file.absPath)) {
        this.scheduled.add(file.absPath);
        this.pending.push(file);
      }
    }
  }

  /**
   * Scan the queued files one at a time (evaluation shares the OCC mutex
   * with renders, so parallel requests would only queue there), each file's
   * tiles landing as its result does. The toggle can grow or shrink the
   * queue while this runs; a second call during a run joins it.
   */
  private async pump(ac: AbortController): Promise<void> {
    if (this.pumpOwner === ac) {
      return;
    }
    this.pumpOwner = ac;
    try {
      while (this.pending.length > 0) {
        const file = this.pending.shift()!;
        this.setStatus(`Scanning files… ${this.scannedCount}/${this.scannedCount + this.pending.length + 1}`);
        const result = await scanPartCatalogFile(file.absPath, ac.signal);
        if (ac.signal.aborted) {
          return;
        }
        this.scannedCount++;
        if (result === null) {
          this.failures.push({ file, text: file.path });
          continue;
        }
        for (const err of result.errors) {
          const text = err.exportName ? `${file.path} · ${err.exportName}: ${err.message}` : `${file.path}: ${err.message}`;
          this.skipped.push({ file, text });
        }
        this.appendTiles(file, result);
        this.applyFilter();
      }
    } finally {
      if (this.pumpOwner === ac) {
        this.pumpOwner = null;
      }
    }
    if (!ac.signal.aborted) {
      this.showScanOutcome();
    }
  }

  /** The status line once the queue is drained, counting only the files in view. */
  private showScanOutcome(): void {
    const failures = this.failures.filter(f => this.visibleFile(f.file)).map(f => f.text);
    const skipped = this.skipped.filter(s => this.visibleFile(s.file)).map(s => s.text);
    const shownTiles = this.tileEls().filter(el => el.dataset.library !== '1' || this.showLibrary);
    if (failures.length > 0) {
      this.setStatus(
        `${failures.length} file${failures.length === 1 ? '' : 's'} failed to scan.`,
        true,
        failures.join('\n'),
      );
    } else if (shownTiles.length === 0) {
      const hiddenLibrary = !this.showLibrary && this.files.some(file => InsertPartDialog.isLibrary(file));
      this.setStatus(
        hiddenLibrary ? 'Nothing insertable in this project. Turn on Show library parts to see your library.' : 'Nothing insertable found.',
        false,
        skipped.join('\n'),
      );
    } else if (skipped.length > 0) {
      this.setStatus(
        `${skipped.length} export${skipped.length === 1 ? '' : 's'} skipped.`,
        false,
        skipped.join('\n'),
      );
    } else {
      this.setStatus('');
    }
  }

  /**
   * The Show library parts toggle. On queues the library files not yet
   * scanned this load (the scanned ones just reappear); off hides their
   * tiles, drops the ones still waiting, and unqueues their instances —
   * nothing inserts from a list the user can't see.
   */
  private setShowLibrary(on: boolean): void {
    this.showLibrary = on;
    if (on) {
      this.schedule(this.files.filter(file => InsertPartDialog.isLibrary(file)));
    } else {
      for (const file of this.pending.filter(f => InsertPartDialog.isLibrary(f))) {
        this.scheduled.delete(file.absPath);
      }
      this.pending = this.pending.filter(file => !InsertPartDialog.isLibrary(file));
      this.unqueueLibrary();
    }
    this.applyFilter();
    const ac = this.abort;
    if (ac === null || ac.signal.aborted || this.pumpOwner !== null) {
      return;
    }
    if (this.pending.length > 0) {
      void this.pump(ac);
    } else if (this.files.length > 0) {
      this.showScanOutcome();
    }
  }

  /** Drop every queued instance of a library package's part. */
  private unqueueLibrary(): void {
    const dropped = this.basket.filter(entry => InsertPartDialog.isLibrary(entry.file));
    if (dropped.length === 0) {
      return;
    }
    for (const entry of dropped) {
      entry.form?.destroy();
      const state = this.tiles.get(entry.key);
      if (state) {
        state.queued = 0;
        this.updateTileBadge(state);
      }
    }
    this.basket = this.basket.filter(entry => !InsertPartDialog.isLibrary(entry.file));
    this.updateFooter();
  }

  /**
   * Show only the tiles matching the active chip (and the library toggle),
   * and a group's heading only while it shows a tile and some package group
   * is in view beside it.
   */
  private applyFilter(): void {
    for (const el of this.tileEls()) {
      const kind = el.dataset.kind;
      const show = (this.filter === 'all'
        || (this.filter === 'parts' ? kind === 'part' : kind === 'assembly'))
        && (this.showLibrary || el.dataset.library !== '1');
      el.classList.toggle('hidden', !show);
    }
    const isShown = (grid: HTMLDivElement) => Array.from(grid.children).some(tile => !tile.classList.contains('hidden'));
    const headed = [...this.groups.values()].some(group => group.pkg !== null && isShown(group.grid));
    for (const group of this.groups.values()) {
      const shown = isShown(group.grid);
      group.heading.classList.toggle('hidden', !headed || !shown);
      group.heading.classList.toggle('flex', headed && shown);
      group.grid.classList.toggle('hidden', !shown);
    }
    const libraryShown = [...this.groups.values()]
      .some(group => group.pkg?.availability === 'library' && isShown(group.grid));
    this.libraryHeading.classList.toggle('hidden', !libraryShown);
  }

  private tileEls(): HTMLElement[] {
    return [...this.groups.values()].flatMap(group => Array.from(group.grid.children) as HTMLElement[]);
  }

  /**
   * The grid a file's tiles go in: the workspace's own first, then one per
   * package the project uses (by name, then version) under a heading naming
   * it, then — below a "From library" heading — one per library package the
   * project doesn't use yet (inserting one adds it). Headings show only once
   * a package is in the dialog, so a workspace with none keeps the plain grid.
   */
  private gridFor(file: CatalogFileEntry): HTMLDivElement {
    const pkg = file.package ?? null;
    const key = pkg ? `${pkg.name}@${pkg.version}` : '';
    const existing = this.groups.get(key);
    if (existing) {
      if (pkg && existing.pkg?.availability !== pkg.availability) {
        existing.pkg = pkg;
      }
      return existing.grid;
    }
    const heading = InsertPartDialog.groupHeading(pkg);
    const grid = document.createElement('div');
    grid.className = 'grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-2 content-start mb-2';
    grid.dataset.group = pkg ? pkg.name : 'workspace';
    this.groups.set(key, { pkg, heading, grid });
    // Keep the groups in order: the workspace's, the project's packages by
    // key, then the library's by key under their section heading.
    const tier = (group: { pkg: CatalogFileEntry['package'] | null }) =>
      group.pkg === null ? 0 : group.pkg.availability === 'library' ? 2 : 1;
    const ordered = [...this.groups.entries()]
      .sort(([a, ga], [b, gb]) => tier(ga) - tier(gb) || a.localeCompare(b))
      .map(([, group]) => group);
    const children: HTMLElement[] = [];
    for (const group of ordered) {
      if (tier(group) === 2 && !children.includes(this.libraryHeading)) {
        children.push(this.libraryHeading);
      }
      children.push(group.heading, group.grid);
    }
    this.gridEl.replaceChildren(...children);
    return grid;
  }

  /** Type style shared by the "This project" and "From library" section headings. */
  private static readonly SECTION_HEADING = 'text-sm font-semibold text-base-content/85';

  private static libraryHeading(): HTMLDivElement {
    const heading = document.createElement('div');
    heading.className = `hidden mt-2 px-0.5 ${InsertPartDialog.SECTION_HEADING}`;
    heading.dataset.ref = 'library-heading';
    heading.textContent = 'From library';
    heading.title = 'In your library, not used by this project yet: inserting one of these parts adds its package to the project.';
    return heading;
  }

  private static groupHeading(pkg: CatalogFileEntry['package'] | null): HTMLDivElement {
    const heading = document.createElement('div');
    // `hidden` and `flex` both set display: applyFilter swaps one for the other.
    heading.className = 'hidden items-center gap-1.5 px-0.5 pt-1 text-[11px] text-base-content/55';
    heading.dataset.groupHeading = pkg ? pkg.name : 'workspace';
    const name = document.createElement('span');
    // The workspace's heading is a section heading, like "From library";
    // a package's is a smaller label inside its section.
    name.className = pkg ? 'font-medium text-base-content/70 truncate' : `truncate ${InsertPartDialog.SECTION_HEADING}`;
    name.textContent = pkg ? pkg.name : 'This project';
    heading.appendChild(name);
    if (pkg) {
      const version = document.createElement('span');
      version.className = 'tabular-nums';
      version.textContent = pkg.version;
      heading.appendChild(version);
    }
    return heading;
  }

  private appendTiles(file: CatalogFileEntry, result: CatalogScanResult): void {
    // The engine's answer wins over the file list's static read; servers
    // predating units give neither, and an unknown unit draws no badge.
    const unit = result.unit ?? file.unit;
    for (const part of result.parts) {
      const generated = GeneratedDefinition.fromScan(file, part, unit ?? sceneUnit.current);
      if (generated) {
        this.gridFor(file).appendChild(this.buildGeneratedTile(generated, file, unit));
        continue;
      }
      const params = part.params ?? [];
      const paramNote = params.length > 0
        ? ` · ${params.length} parameter${params.length === 1 ? '' : 's'}`
        : '';
      this.gridFor(file).appendChild(this.buildTile({
        kind: 'part',
        thumb: this.thumbs.render(part.objects, part.rootId),
        title: part.partName,
        subtitle: part.kind === 'factory' ? `${part.exportName}()` : part.exportName,
        file,
        unit,
        tooltip: `Queue ${part.partName}${paramNote}`,
        exportName: part.exportName,
        insertKind: part.kind,
        params,
        configurations: part.configurations ?? [],
      }));
    }
    for (const sub of result.assemblies ?? []) {
      const generated = GeneratedDefinition.fromScan(file, sub, unit ?? sceneUnit.current);
      if (generated) {
        this.gridFor(file).appendChild(this.buildGeneratedTile(generated, file, unit));
        continue;
      }
      const count = sub.instances.length;
      // 'value' exports insert as `insert(name)`, 'factory' as `insert(name())`
      // — the same shapes parts use, since insert() accepts assembly()
      // definitions. Servers predating definitions omit exportKind: treat as
      // factory (the legacy sub-assembly style was a zero-arg factory).
      const exportKind = sub.exportKind ?? 'factory';
      const params = sub.params ?? [];
      this.gridFor(file).appendChild(this.buildTile({
        kind: 'assembly',
        thumb: this.thumbs.renderAssembly(sub.objects, sub.instances, sub.mates, sub.connectors ?? []),
        title: sub.assemblyName ?? sub.exportName,
        subtitle: `assembly · ${count} instance${count === 1 ? '' : 's'}`,
        file,
        unit,
        tooltip: `Queue sub-assembly ${sub.assemblyName ?? sub.exportName}`,
        exportName: sub.exportName,
        insertKind: exportKind,
        params,
        configurations: sub.configurations ?? [],
      }));
    }
  }

  private buildTile(opts: {
    kind: 'part' | 'assembly';
    thumb: string | null;
    title: string;
    subtitle: string;
    file: CatalogFileEntry;
    /** The entry's authoring unit; undefined when the server can't say. */
    unit: LengthUnit | undefined;
    tooltip: string;
    exportName: string;
    insertKind: CatalogEntryKind;
    params: CatalogParamDef[];
    configurations: CatalogConfiguration[];
  }): HTMLButtonElement {
    const tile = document.createElement('button');
    tile.className = 'group relative flex flex-col items-center gap-1 p-2 w-full rounded-lg border border-base-content/10 '
      + 'hover:border-primary hover:bg-base-200 cursor-pointer transition-colors';
    tile.dataset.kind = opts.kind;
    if (InsertPartDialog.isLibrary(opts.file)) {
      tile.dataset.library = '1';
    }
    tile.title = opts.tooltip;

    const key = `${opts.file.absPath}::${opts.exportName}`;

    // Queued/inserted badge — seated INSIDE the tile corner: the grid is a
    // scroll container, so anything hanging outside a first-row/last-column
    // tile would be clipped at its edges.
    const badge = document.createElement('span');
    badge.className = 'absolute top-1 right-1 z-10 hidden rounded-full bg-primary text-primary-content '
      + 'text-[9px] leading-none px-1.5 py-1 shadow pointer-events-none';
    tile.appendChild(badge);

    // Hover-only − removes the last queued instance of this tile.
    const minus = document.createElement('button');
    minus.className = 'absolute top-1 left-1 z-10 hidden group-hover:flex items-center justify-center '
      + 'w-4 h-4 rounded-full bg-base-300 text-base-content/70 text-[10px] leading-none hover:bg-error hover:text-error-content';
    minus.textContent = '−';
    minus.title = 'Remove one queued instance';
    minus.addEventListener('click', (e) => {
      e.stopPropagation();
      this.unqueue(key);
    });
    tile.appendChild(minus);

    const state: TileState = { key, badge, minus, queued: 0 };
    this.tiles.set(key, state);
    this.updateTileBadge(state);

    if (opts.thumb) {
      const img = document.createElement('img');
      img.className = 'w-24 h-24 object-contain pointer-events-none';
      img.src = opts.thumb;
      img.alt = opts.title;
      tile.appendChild(img);
    } else {
      const placeholder = document.createElement('div');
      placeholder.className = 'w-24 h-24 flex items-center justify-center text-base-content/25 text-2xl';
      placeholder.textContent = '∅';
      tile.appendChild(placeholder);
    }

    const name = document.createElement('span');
    name.className = 'text-xs text-base-content/90 truncate w-full text-center';
    name.textContent = opts.title;
    const subtitle = document.createElement('span');
    subtitle.className = 'text-[10px] text-base-content/50 truncate w-full text-center';
    subtitle.textContent = opts.params.length > 0
      ? `${opts.subtitle} · ${opts.params.length} param${opts.params.length === 1 ? '' : 's'}`
      : opts.subtitle;
    // The grid is flat, so each tile names its defining file — the grouping
    // cue that replaced the per-file section headers.
    const fileCaption = document.createElement('span');
    fileCaption.className = 'text-[9px] text-base-content/35 truncate w-full text-center';
    fileCaption.textContent = opts.file.path;
    fileCaption.title = opts.file.absPath;
    tile.appendChild(name);
    tile.appendChild(subtitle);
    tile.appendChild(fileCaption);
    // A part authored in another unit is scaled into this assembly's unit on
    // insert — say so on the tile, since its numbers won't match the grid.
    if (opts.unit !== undefined && opts.unit !== sceneUnit.current) {
      const unitBadge = document.createElement('span');
      unitBadge.className = 'absolute top-1 left-1 px-1 rounded text-[9px] leading-4 '
        + 'bg-warning/20 text-warning-content/80 border border-warning/40 pointer-events-none';
      unitBadge.textContent = opts.unit;
      unitBadge.title = `${opts.kind === 'assembly' ? 'Sub-assembly' : 'Part'} is in ${UNIT_NAMES[opts.unit]}; `
        + `it is scaled into this assembly's unit (${sceneUnit.current}).`;
      tile.appendChild(unitBadge);
    }

    tile.addEventListener('click', () => {
      this.basket.push({
        key,
        file: opts.file,
        exportName: opts.exportName,
        kind: opts.insertKind,
        displayName: opts.title,
        params: opts.params,
        configurations: opts.configurations,
        configuration: DEFAULT_CONFIGURATION,
        thumb: opts.thumb,
        form: null,
      });
      state.queued++;
      this.updateTileBadge(state);
      this.updateFooter();
    });
    return tile;
  }

  /**
   * A generated definition's tile: its icon over its label, "generated part"
   * or "generated assembly", the defining file. A click opens its dialog
   * and closes this one — refused, with the reason in the status line,
   * while instances are queued (they would be dropped).
   */
  private buildGeneratedTile(definition: GeneratedDefinition, file: CatalogFileEntry, unit: LengthUnit | undefined): HTMLButtonElement {
    const tile = document.createElement('button');
    tile.className = 'group relative flex flex-col items-center gap-1 p-2 w-full rounded-lg border border-base-content/10 '
      + 'hover:border-primary hover:bg-base-200 cursor-pointer transition-colors';
    tile.dataset.kind = definition.kind;
    tile.dataset.generated = definition.id;
    if (InsertPartDialog.isLibrary(file)) {
      tile.dataset.library = '1';
    }
    tile.title = `${definition.tip} — opens its dialog with a live preview`;
    const img = document.createElement('img');
    img.className = 'w-24 h-24 object-contain p-4 pointer-events-none';
    img.src = definition.iconSrc;
    img.alt = definition.label;
    const name = document.createElement('span');
    name.className = 'text-xs text-base-content/90 truncate w-full text-center';
    name.textContent = definition.label;
    const subtitle = document.createElement('span');
    subtitle.className = 'text-[10px] text-base-content/50 truncate w-full text-center';
    subtitle.textContent = `generated ${definition.kind}`;
    const fileCaption = document.createElement('span');
    fileCaption.className = 'text-[9px] text-base-content/35 truncate w-full text-center';
    fileCaption.textContent = file.path;
    fileCaption.title = file.absPath;
    tile.append(img, name, subtitle, fileCaption);
    if (unit !== undefined && unit !== sceneUnit.current) {
      const unitBadge = document.createElement('span');
      unitBadge.className = 'absolute top-1 left-1 px-1 rounded text-[9px] leading-4 '
        + 'bg-warning/20 text-warning-content/80 border border-warning/40 pointer-events-none';
      unitBadge.textContent = unit;
      unitBadge.title = `${definition.kind === 'assembly' ? 'Sub-assembly' : 'Part'} is in ${UNIT_NAMES[unit]}; `
        + `it is scaled into this assembly's unit (${sceneUnit.current}).`;
      tile.appendChild(unitBadge);
    }
    tile.addEventListener('click', () => {
      if (this.basket.length > 0) {
        this.setStatus(
          `Insert the ${this.basket.length} queued first, or remove them: ${definition.label} opens its own dialog.`,
          true,
        );
        return;
      }
      this.hide();
      this.onGenerated?.(definition);
    });
    return tile;
  }

  private unqueue(key: string): void {
    for (let i = this.basket.length - 1; i >= 0; i--) {
      if (this.basket[i].key === key) {
        this.basket[i].form?.destroy();
        this.basket.splice(i, 1);
        break;
      }
    }
    const state = this.tiles.get(key);
    if (state && state.queued > 0) {
      state.queued--;
      this.updateTileBadge(state);
    }
    this.updateFooter();
  }

  private updateTileBadge(state: TileState): void {
    if (state.queued > 0) {
      state.badge.textContent = `${state.queued} queued`;
      state.badge.classList.remove('hidden');
    } else {
      state.badge.classList.add('hidden');
    }
    state.minus.classList.toggle('hidden', state.queued === 0);
  }

  private updateFooter(): void {
    const total = this.basket.length;
    const withParams = this.basket.filter(e => e.params.length > 0).length;
    const note = this.overlay.querySelector<HTMLSpanElement>('[data-ref="queued-note"]')!;
    note.textContent = total > 0 ? `${total} queued` : '';
    this.nextBtn.disabled = total === 0 || this.inserting;
    this.nextBtn.textContent = withParams > 0 ? 'Next ›' : `Insert${total > 0 ? ` ${total}` : ''}`;
  }

  /** Footer button: straight to insert when nothing queued needs parameters. */
  private async advance(): Promise<void> {
    if (this.basket.length === 0) {
      return;
    }
    // Group queued instances by part (first-queued order) — one carousel
    // page per distinct parameterized part, its instances as rows.
    const groups = new Map<string, PageGroup>();
    for (const entry of this.basket) {
      if (entry.params.length === 0) {
        continue;
      }
      let group = groups.get(entry.key);
      if (!group) {
        group = {
          key: entry.key,
          displayName: entry.displayName,
          filePath: entry.file.path,
          thumb: entry.thumb,
          entries: [],
        };
        groups.set(entry.key, group);
      }
      group.entries.push(entry);
    }
    this.pages = Array.from(groups.values());
    if (this.pages.length === 0) {
      await this.insertAll();
      return;
    }
    this.showParamsStep();
  }

  private showSelectStep(): void {
    this.selectStepEl.classList.remove('hidden');
    this.selectStepEl.classList.add('flex');
    this.paramsStepEl.classList.add('hidden');
    this.paramsStepEl.classList.remove('flex');
    this.overlay.querySelector('[data-ref="title"]')!.textContent = 'Insert part';
    this.updateFooter();
  }

  private showParamsStep(): void {
    this.selectStepEl.classList.add('hidden');
    this.selectStepEl.classList.remove('flex');
    this.paramsStepEl.classList.remove('hidden');
    this.paramsStepEl.classList.add('flex');
    this.overlay.querySelector('[data-ref="title"]')!.textContent = 'Parameters';
    this.showPage(0);
  }

  private showPage(index: number): void {
    this.pageIndex = Math.max(0, Math.min(index, this.pages.length - 1));
    const group = this.pages[this.pageIndex];
    this.pageHostEl.innerHTML = '';

    const page = document.createElement('div');
    page.className = 'flex flex-col gap-2 px-4';

    const header = document.createElement('div');
    header.className = 'flex items-baseline gap-2 pb-1';
    const title = document.createElement('span');
    title.className = 'text-sm text-base-content/90';
    title.textContent = group.displayName;
    const caption = document.createElement('span');
    caption.className = 'text-[10px] text-base-content/40';
    caption.textContent = group.filePath;
    header.appendChild(title);
    header.appendChild(caption);
    page.appendChild(header);

    // One row per queued instance: thumbnail left, that instance's
    // parameters right — several instances of one part configure in a
    // single step.
    group.entries.forEach((entry, i) => {
      const row = document.createElement('div');
      row.className = 'flex items-start gap-4 rounded-lg border border-base-content/10 p-3';

      if (entry.thumb) {
        const img = document.createElement('img');
        img.className = 'w-20 h-20 object-contain shrink-0';
        img.src = entry.thumb;
        img.alt = entry.displayName;
        row.appendChild(img);
      } else {
        const placeholder = document.createElement('div');
        placeholder.className = 'w-20 h-20 flex items-center justify-center text-base-content/25 text-2xl shrink-0';
        placeholder.textContent = '∅';
        row.appendChild(placeholder);
      }

      const right = document.createElement('div');
      right.className = 'flex-1 min-w-0 flex flex-col gap-1.5';
      if (group.entries.length > 1) {
        const label = document.createElement('span');
        label.className = 'text-[10px] uppercase tracking-wide text-base-content/40';
        label.textContent = `Instance ${i + 1}`;
        right.appendChild(label);
      }
      if (entry.configurations.length > 0) {
        right.appendChild(this.buildConfigurationSelect(entry));
      }
      if (!entry.form) {
        entry.form = this.buildForm(entry);
      }
      right.appendChild(entry.form.element);
      row.appendChild(right);

      page.appendChild(row);
    });

    this.pageHostEl.appendChild(page);

    const paramless = this.basket.filter(e => e.params.length === 0).length;
    const count = group.entries.length;
    this.pagePosEl.textContent = `${this.pageIndex + 1} / ${this.pages.length} · ${group.displayName}`
      + (count > 1 ? ` · ${count} instances` : '')
      + (paramless > 0 ? ` · +${paramless} without parameters` : '');

    this.nextPageBtn.textContent = this.pageIndex === this.pages.length - 1
      ? `Insert ${this.basket.length}`
      : 'Next ›';
  }

  /**
   * The instance's form, seeded with its row's values over the scanned
   * defaults — so the commit's diff is exactly what differs from the row
   * (the cell, else the default), which is all the statement's override
   * object then carries.
   */
  private buildForm(entry: BasketEntry): ParamForm {
    const cells = entry.configurations.find(c => c.name === entry.configuration)?.values ?? {};
    const defs = entry.params.map(def => (
      Object.prototype.hasOwnProperty.call(cells, def.label) ? { ...def, currentValue: cells[def.label] } : def
    ));
    const form = new ParamForm(defs, { expressions: { seeds: {}, variables: this.variables } });
    form.onSubmit = () => void this.pageForward();
    return form;
  }

  /**
   * The Configuration select above an instance's form: Default, then the
   * definition's rows. Picking one refills the form with that row's values
   * — edits made on the previous row's values start over from the new row.
   */
  private buildConfigurationSelect(entry: BasketEntry): HTMLElement {
    const field = document.createElement('label');
    field.className = 'flex flex-col gap-1 pb-1';
    const caption = document.createElement('span');
    caption.className = 'text-xs text-base-content/70';
    caption.textContent = 'Configuration';
    const select = document.createElement('select');
    select.className = 'select select-sm select-bordered w-full';
    select.dataset.insertConfiguration = '';
    for (const name of [DEFAULT_CONFIGURATION, ...entry.configurations.map(c => c.name)]) {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      select.appendChild(option);
    }
    select.value = entry.configuration;
    select.addEventListener('change', () => {
      entry.configuration = select.value;
      const previous = entry.form;
      entry.form = this.buildForm(entry);
      previous?.element.replaceWith(entry.form.element);
      previous?.destroy();
    });
    field.appendChild(caption);
    field.appendChild(select);
    return field;
  }

  /** Prev: the previous part's page, or from the first back to the grid — the queue and the values typed so far kept. */
  private pageBack(): void {
    if (this.pageIndex > 0) {
      this.showPage(this.pageIndex - 1);
      return;
    }
    this.showSelectStep();
  }

  private async pageForward(): Promise<void> {
    if (this.pageIndex < this.pages.length - 1) {
      this.showPage(this.pageIndex + 1);
      return;
    }
    await this.insertAll();
  }

  /**
   * Commit the basket as ONE batch edit; the server derives fresh variable
   * names against the evolving file, so a batch never collides with itself.
   */
  private async insertAll(): Promise<boolean> {
    if (this.inserting || this.basket.length === 0) {
      return false;
    }
    const inserts: CatalogInsertRequest[] = [];
    const reads: { newVariables?: NewVariable[] }[] = [];
    for (const entry of this.basket) {
      const commit = entry.form?.commitChanges() ?? { set: {} };
      if ('error' in commit) {
        const page = this.pages.findIndex(group => group.entries.includes(entry));
        if (page >= 0) this.showPage(page);
        this.setStatus(commit.error, true);
        return false;
      }
      reads.push(commit);
      inserts.push({
        file: entry.file.absPath,
        exportName: entry.exportName,
        kind: entry.kind,
        ...(Object.keys(commit.set).length > 0 ? { params: commit.set } : {}),
        ...(entry.configuration !== DEFAULT_CONFIGURATION ? { configuration: entry.configuration } : {}),
      });
    }
    const declarations = collectNewVariablesChecked(reads);
    if ('error' in declarations) {
      this.setStatus(declarations.error, true);
      return false;
    }
    this.inserting = true;
    this.updateFooter();
    this.setStatus(`Inserting ${this.basket.length}…`);
    const session = this.abort;
    const result = await insertCatalogParts(inserts, declarations.newVariables);
    if (session !== this.abort) return false;
    this.inserting = false;

    if (!result.success) {
      this.setStatus(result.reason ?? 'Insert failed.', true);
      this.showSelectStep();
      return false;
    }

    // The basket landed — the placement is done, so the dialog closes and
    // the new instances take the stage in the viewport.
    this.hide();
    return true;
  }
}
