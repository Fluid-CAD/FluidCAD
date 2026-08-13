import {
  getPartCatalogFiles,
  insertCatalogParts,
  scanPartCatalogFile,
  type CatalogEntryKind,
  type CatalogFileEntry,
  type CatalogInsertRequest,
  type CatalogParamDef,
  type CatalogScanResult,
} from '../../api';
import { ICON_CLOSE } from '../icons';
import { ParamForm } from '../param-controls';
import { PartThumbnailRenderer } from './part-thumbnails';

type CatalogFilter = 'all' | 'parts' | 'assemblies';

/** One queued instance — tile clicks append these, Insert commits them all. */
type BasketEntry = {
  key: string;
  file: CatalogFileEntry;
  exportName: string;
  kind: CatalogEntryKind;
  displayName: string;
  params: CatalogParamDef[];
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
 * more; hover reveals a − to remove); the footer button advances.
 *
 * Step 2 (parameters): one carousel page per queued instance that declares
 * `param()`s — two queued extrusions can get different lengths in one pass —
 * with a form rendered from the scanned definitions. Paramless entries skip
 * the step entirely (the footer button reads "Insert N" straight away).
 *
 * Insert commits the whole basket as ONE batch edit: one editor round trip,
 * one re-render, statement per instance — then the dialog closes, letting
 * the new instances take the stage in the viewport. A failed commit stays
 * open on the grid with the reason in the status line.
 *
 * Everything reloads on every open: unchanged files answer from the server's
 * mtime-keyed scan cache, so freshness costs one round-trip per file, not a
 * re-evaluation.
 */
export class InsertPartDialog {
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
  /** Sticky across opens — reset only by the user clicking another chip. */
  private filter: CatalogFilter = 'all';
  /** The open assembly file — its own entries are excluded from the grid. */
  private excludeAbsPath: string | null = null;

  private basket: BasketEntry[] = [];
  private tiles = new Map<string, TileState>();
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
    this.overlay.querySelector('[data-ref="back-btn"]')!.addEventListener('click', () => this.showSelectStep());
    this.nextBtn.addEventListener('click', () => void this.advance());
    this.prevPageBtn.addEventListener('click', () => this.showPage(this.pageIndex - 1));
    this.nextPageBtn.addEventListener('click', () => void this.pageForward());
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
      if (e.key === 'Escape' && !this.overlay.classList.contains('hidden')) {
        e.stopPropagation();
        this.hide();
      }
    }, true);
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
    this.thumbs.dispose();
    this.basket = [];
    this.pages = [];
    this.overlay.classList.add('hidden');
  }

  private buildHTML(): string {
    return `
      <div class="w-[680px] max-w-[92vw] h-[78vh] bg-base-100 border border-base-content/10 rounded-lg p-5 shadow-[0_4px_24px_rgba(0,0,0,0.5)] flex flex-col">
        <div class="flex items-center justify-between mb-3">
          <div class="flex items-center gap-2">
            <button data-ref="back-btn" class="btn btn-ghost btn-xs text-base-content/60 hidden">‹ Back</button>
            <h3 data-ref="title" class="text-sm font-medium text-base-content/90">Insert part</h3>
          </div>
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
          </div>
          <div data-ref="status" class="text-xs text-base-content/50 mb-2 min-h-4"></div>
          <div data-ref="tree" class="overflow-y-auto flex-1 grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-2 content-start"></div>
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
    this.abort?.abort();
    const ac = new AbortController();
    this.abort = ac;
    this.inserting = false;
    this.gridEl.innerHTML = '';
    this.tiles.clear();
    this.basket = [];
    this.updateFooter();
    this.setStatus('Looking for part files…');

    const allFiles = await getPartCatalogFiles(ac.signal);
    if (ac.signal.aborted) {
      return;
    }
    if (allFiles === null) {
      this.setStatus('Could not reach the FluidCAD server.', true);
      return;
    }
    // The open assembly can't be inserted into itself — drop its file.
    const files = allFiles.filter(f => f.absPath !== this.excludeAbsPath);
    if (files.length === 0) {
      this.setStatus('No other part or assembly files in this workspace.');
      return;
    }

    const failures: string[] = [];
    const skipped: string[] = [];
    let done = 0;
    this.setStatus(`Scanning files… 0/${files.length}`);
    for (const file of files) {
      const result = await scanPartCatalogFile(file.absPath, ac.signal);
      if (ac.signal.aborted) {
        return;
      }
      done++;
      this.setStatus(`Scanning files… ${done}/${files.length}`);
      if (result === null) {
        failures.push(file.path);
        continue;
      }
      for (const err of result.errors) {
        skipped.push(err.exportName ? `${file.path} · ${err.exportName}: ${err.message}` : `${file.path}: ${err.message}`);
      }
      this.appendTiles(file, result);
      this.applyFilter();
    }

    if (failures.length > 0) {
      this.setStatus(
        `${failures.length} file${failures.length === 1 ? '' : 's'} failed to scan.`,
        true,
        failures.join('\n'),
      );
    } else if (this.gridEl.children.length === 0) {
      this.setStatus('Nothing insertable found.', false, skipped.join('\n'));
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

  /** Show only the tiles matching the active chip. */
  private applyFilter(): void {
    for (const el of Array.from(this.gridEl.children) as HTMLElement[]) {
      const kind = el.dataset.kind;
      const show = this.filter === 'all'
        || (this.filter === 'parts' ? kind === 'part' : kind === 'assembly');
      el.classList.toggle('hidden', !show);
    }
  }

  private appendTiles(file: CatalogFileEntry, result: CatalogScanResult): void {
    for (const part of result.parts) {
      const params = part.params ?? [];
      const paramNote = params.length > 0
        ? ` · ${params.length} parameter${params.length === 1 ? '' : 's'}`
        : '';
      this.gridEl.appendChild(this.buildTile({
        kind: 'part',
        thumb: this.thumbs.render(part.objects, part.rootId),
        title: part.partName,
        subtitle: part.kind === 'factory' ? `${part.exportName}()` : part.exportName,
        file,
        tooltip: `Queue ${part.partName}${paramNote}`,
        exportName: part.exportName,
        insertKind: part.kind,
        params,
      }));
    }
    for (const sub of result.assemblies ?? []) {
      const count = sub.instances.length;
      // 'value' exports insert as `insert(name)`, 'factory' as `insert(name())`
      // — the same shapes parts use, since insert() accepts assembly()
      // definitions. Servers predating definitions omit exportKind: treat as
      // factory (the legacy sub-assembly style was a zero-arg factory).
      const exportKind = sub.exportKind ?? 'factory';
      const params = sub.params ?? [];
      this.gridEl.appendChild(this.buildTile({
        kind: 'assembly',
        thumb: this.thumbs.renderAssembly(sub.objects, sub.instances, sub.mates),
        title: sub.assemblyName ?? sub.exportName,
        subtitle: `assembly · ${count} instance${count === 1 ? '' : 's'}`,
        file,
        tooltip: `Queue sub-assembly ${sub.assemblyName ?? sub.exportName}`,
        exportName: sub.exportName,
        insertKind: exportKind,
        params,
      }));
    }
  }

  private buildTile(opts: {
    kind: 'part' | 'assembly';
    thumb: string | null;
    title: string;
    subtitle: string;
    file: CatalogFileEntry;
    tooltip: string;
    exportName: string;
    insertKind: CatalogEntryKind;
    params: CatalogParamDef[];
  }): HTMLButtonElement {
    const tile = document.createElement('button');
    tile.className = 'group relative flex flex-col items-center gap-1 p-2 w-full rounded-lg border border-base-content/10 '
      + 'hover:border-primary hover:bg-base-200 cursor-pointer transition-colors';
    tile.dataset.kind = opts.kind;
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

    tile.addEventListener('click', () => {
      this.basket.push({
        key,
        file: opts.file,
        exportName: opts.exportName,
        kind: opts.insertKind,
        displayName: opts.title,
        params: opts.params,
        thumb: opts.thumb,
        form: null,
      });
      state.queued++;
      this.updateTileBadge(state);
      this.updateFooter();
    });
    return tile;
  }

  private unqueue(key: string): void {
    for (let i = this.basket.length - 1; i >= 0; i--) {
      if (this.basket[i].key === key) {
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
    this.overlay.querySelector('[data-ref="back-btn"]')!.classList.add('hidden');
    this.overlay.querySelector('[data-ref="title"]')!.textContent = 'Insert part';
    this.updateFooter();
  }

  private showParamsStep(): void {
    this.selectStepEl.classList.add('hidden');
    this.selectStepEl.classList.remove('flex');
    this.paramsStepEl.classList.remove('hidden');
    this.paramsStepEl.classList.add('flex');
    this.overlay.querySelector('[data-ref="back-btn"]')!.classList.remove('hidden');
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
      if (!entry.form) {
        entry.form = new ParamForm(entry.params);
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

    this.prevPageBtn.disabled = this.pageIndex === 0;
    this.nextPageBtn.textContent = this.pageIndex === this.pages.length - 1
      ? `Insert ${this.basket.length}`
      : 'Next ›';
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
    this.inserting = true;
    this.updateFooter();
    this.setStatus(`Inserting ${this.basket.length}…`);

    const inserts: CatalogInsertRequest[] = this.basket.map(entry => {
      const params = entry.form?.nonDefaultValues() ?? {};
      return {
        file: entry.file.absPath,
        exportName: entry.exportName,
        kind: entry.kind,
        ...(Object.keys(params).length > 0 ? { params } : {}),
      };
    });
    const result = await insertCatalogParts(inserts);
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
