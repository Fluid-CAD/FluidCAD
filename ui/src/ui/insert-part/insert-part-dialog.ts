import {
  getPartCatalogFiles,
  insertCatalogPart,
  scanPartCatalogFile,
  type CatalogEntryKind,
  type CatalogFileEntry,
  type CatalogScanResult,
} from '../../api';
import { ICON_CLOSE } from '../icons';
import { PartThumbnailRenderer } from './part-thumbnails';

type CatalogFilter = 'all' | 'parts' | 'assemblies';

/**
 * The assembly toolbar's Insert dialog: one grid of every insertable part
 * and sub-assembly in the workspace, one tile each with a thumbnail and the
 * defining file as its caption. Candidate files come from the catalog's
 * cheap prefilter; each is then scanned server-side in turn (evaluation
 * shares the OCC mutex with renders, so sequential requests add no latency)
 * and its tiles pop into the grid as results land — grouped by file simply
 * because scans complete in file order. Clicking a tile writes the insert
 * statement into the current assembly file through the apply-feature-edit
 * round trip and leaves the dialog open, so several instances (of several
 * entries) can be placed in one visit — a per-tile badge tallies them.
 *
 * Everything reloads on every open: unchanged files answer from the
 * server's mtime-keyed scan cache, so freshness costs one round-trip per
 * file, not a re-evaluation.
 */
export class InsertPartDialog {
  private overlay: HTMLDivElement;
  private gridEl: HTMLDivElement;
  private statusEl: HTMLDivElement;
  private thumbs = new PartThumbnailRenderer();
  private abort: AbortController | null = null;
  private inserting = false;
  /** Sticky across opens — reset only by the user clicking another chip. */
  private filter: CatalogFilter = 'all';
  /** The open assembly file — its own entries are excluded from the grid. */
  private excludeAbsPath: string | null = null;

  constructor(container: HTMLElement) {
    this.overlay = document.createElement('div');
    this.overlay.className = 'fixed inset-0 z-[300] bg-black/50 flex items-center justify-center hidden';
    this.overlay.innerHTML = this.buildHTML();
    container.appendChild(this.overlay);

    this.gridEl = this.overlay.querySelector('[data-ref="tree"]')!;
    this.statusEl = this.overlay.querySelector('[data-ref="status"]')!;

    this.overlay.querySelector('[data-ref="close-btn"]')!.addEventListener('click', () => this.hide());
    this.overlay.querySelector('[data-ref="refresh-btn"]')!.addEventListener('click', () => void this.load());
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
    void this.load();
  }

  hide(): void {
    this.abort?.abort();
    this.abort = null;
    this.thumbs.dispose();
    this.overlay.classList.add('hidden');
  }

  private buildHTML(): string {
    return `
      <div class="w-[680px] max-w-[92vw] max-h-[78vh] bg-base-100 border border-base-content/10 rounded-lg p-5 shadow-[0_4px_24px_rgba(0,0,0,0.5)] flex flex-col">
        <div class="flex items-center justify-between mb-3">
          <h3 class="text-sm font-medium text-base-content/90">Insert part</h3>
          <div class="flex items-center gap-1">
            <button data-ref="refresh-btn" class="btn btn-ghost btn-xs text-base-content/60">Refresh</button>
            <button data-ref="close-btn" class="btn btn-ghost btn-square btn-xs text-base-content/60">
              <span class="[&>svg]:size-4">${ICON_CLOSE}</span>
            </button>
          </div>
        </div>
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
      this.gridEl.appendChild(this.buildTile({
        kind: 'part',
        thumb: this.thumbs.render(part.objects, part.rootId),
        title: part.partName,
        subtitle: part.kind === 'factory' ? `${part.exportName}()` : part.exportName,
        file,
        tooltip: part.kind === 'factory'
          ? `Insert ${part.partName} — ${part.exportName}() with default arguments`
          : `Insert ${part.partName}`,
        onPick: () => this.insert(file, part.exportName, part.kind, part.partName),
      }));
    }
    for (const sub of result.assemblies ?? []) {
      const count = sub.instances.length;
      // 'value' exports insert as `insert(name)`, 'factory' as `insert(name())`
      // — the same shapes parts use, since insert() accepts assembly()
      // definitions. Servers predating definitions omit exportKind: treat as
      // factory (the legacy sub-assembly style was a zero-arg factory).
      const exportKind = sub.exportKind ?? 'factory';
      const statement = exportKind === 'factory' ? `${sub.exportName}()` : sub.exportName;
      this.gridEl.appendChild(this.buildTile({
        kind: 'assembly',
        thumb: this.thumbs.renderAssembly(sub.objects, sub.instances, sub.mates),
        title: sub.assemblyName ?? sub.exportName,
        subtitle: `assembly · ${count} instance${count === 1 ? '' : 's'}`,
        file,
        tooltip: exportKind === 'factory'
          ? `Insert sub-assembly — insert(${statement}) with default arguments`
          : `Insert sub-assembly — insert(${statement})`,
        onPick: () => this.insert(file, sub.exportName, exportKind, sub.assemblyName ?? sub.exportName),
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
    /** Resolves true when the insert landed — drives the tile's counter badge. */
    onPick: () => Promise<boolean>;
  }): HTMLButtonElement {
    const tile = document.createElement('button');
    tile.className = 'relative flex flex-col items-center gap-1 p-2 w-full rounded-lg border border-base-content/10 '
      + 'hover:border-primary hover:bg-base-200 cursor-pointer transition-colors';
    tile.dataset.kind = opts.kind;
    tile.title = opts.tooltip;

    // "N inserted" badge — the dialog stays open so several instances (of
    // several entries) can be placed in one visit; the badge tallies this
    // visit's inserts per tile. Seated INSIDE the tile corner: the grid is a
    // scroll container, so anything hanging outside a first-row/last-column
    // tile would be clipped at its edges.
    const badge = document.createElement('span');
    badge.className = 'absolute top-1 right-1 z-10 hidden rounded-full bg-primary text-primary-content '
      + 'text-[9px] leading-none px-1.5 py-1 shadow pointer-events-none';
    tile.appendChild(badge);
    let insertedCount = 0;

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
    subtitle.textContent = opts.subtitle;
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
      void opts.onPick().then(ok => {
        if (ok) {
          insertedCount++;
          badge.textContent = `${insertedCount} inserted`;
          badge.classList.remove('hidden');
        }
      });
    });
    return tile;
  }

  /**
   * Write one insert statement; the dialog stays open so repeated clicks
   * place additional instances (the server derives a fresh variable name
   * from the file's current content each time). Returns whether it landed.
   */
  private async insert(
    file: CatalogFileEntry,
    exportName: string,
    kind: CatalogEntryKind,
    displayName: string,
  ): Promise<boolean> {
    if (this.inserting) {
      return false;
    }
    this.inserting = true;
    this.setStatus(`Inserting ${displayName}…`);
    const result = await insertCatalogPart(file.absPath, exportName, kind);
    this.inserting = false;
    if (result.success) {
      this.setStatus(`Inserted ${displayName}.`);
      return true;
    }
    this.setStatus(result.reason ?? 'Insert failed.', true);
    return false;
  }
}
