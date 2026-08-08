import {
  getPartCatalogFiles,
  insertCatalogPart,
  scanPartCatalogFile,
  type CatalogFileEntry,
  type CatalogScanResult,
} from '../../api';
import { ICON_CLOSE } from '../icons';
import { PartThumbnailRenderer } from './part-thumbnails';

/**
 * The assembly toolbar's Insert dialog: a tree of the workspace's part files
 * with a thumbnail per exported part. Files come from the catalog's cheap
 * prefilter and appear immediately; each is then scanned server-side in turn
 * (evaluation shares the OCC mutex with renders, so sequential requests add
 * no latency) and its part tiles pop in as results land. Clicking a tile
 * writes the `insert()` statement into the current assembly file through the
 * apply-feature-edit round trip — the instance appearing in the viewport is
 * the feedback.
 *
 * Everything reloads on every open: unchanged files answer from the server's
 * mtime-keyed scan cache, so freshness costs one round-trip per file, not a
 * re-evaluation.
 */
export class InsertPartDialog {
  private overlay: HTMLDivElement;
  private treeEl: HTMLDivElement;
  private statusEl: HTMLDivElement;
  private thumbs = new PartThumbnailRenderer();
  private abort: AbortController | null = null;
  private inserting = false;

  constructor(container: HTMLElement) {
    this.overlay = document.createElement('div');
    this.overlay.className = 'fixed inset-0 z-[300] bg-black/50 flex items-center justify-center hidden';
    this.overlay.innerHTML = this.buildHTML();
    container.appendChild(this.overlay);

    this.treeEl = this.overlay.querySelector('[data-ref="tree"]')!;
    this.statusEl = this.overlay.querySelector('[data-ref="status"]')!;

    this.overlay.querySelector('[data-ref="close-btn"]')!.addEventListener('click', () => this.hide());
    this.overlay.querySelector('[data-ref="refresh-btn"]')!.addEventListener('click', () => void this.load());
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

  show(): void {
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
      <div class="w-[560px] max-h-[75vh] bg-base-100 border border-base-content/10 rounded-lg p-5 shadow-[0_4px_24px_rgba(0,0,0,0.5)] flex flex-col">
        <div class="flex items-center justify-between mb-3">
          <h3 class="text-sm font-medium text-base-content/90">Insert part</h3>
          <div class="flex items-center gap-1">
            <button data-ref="refresh-btn" class="btn btn-ghost btn-xs text-base-content/60">Refresh</button>
            <button data-ref="close-btn" class="btn btn-ghost btn-square btn-xs text-base-content/60">
              <span class="[&>svg]:size-4">${ICON_CLOSE}</span>
            </button>
          </div>
        </div>
        <div data-ref="status" class="text-xs text-base-content/50 mb-2 min-h-4"></div>
        <div data-ref="tree" class="overflow-y-auto flex-1 flex flex-col gap-1"></div>
      </div>
    `;
  }

  private setStatus(text: string, isError = false): void {
    this.statusEl.textContent = text;
    this.statusEl.classList.toggle('text-error', isError);
    this.statusEl.classList.toggle('text-base-content/50', !isError);
  }

  private async load(): Promise<void> {
    this.abort?.abort();
    const ac = new AbortController();
    this.abort = ac;
    this.inserting = false;
    this.treeEl.innerHTML = '';
    this.setStatus('Looking for part files…');

    const files = await getPartCatalogFiles(ac.signal);
    if (ac.signal.aborted) {
      return;
    }
    if (files === null) {
      this.setStatus('Could not reach the FluidCAD server.', true);
      return;
    }
    if (files.length === 0) {
      this.setStatus('No files in this workspace mention part(.');
      return;
    }

    const sections = new Map<string, { body: HTMLDivElement; spinner: HTMLElement }>();
    for (const file of files) {
      const section = document.createElement('div');
      const header = document.createElement('div');
      header.className = 'flex items-center gap-2 text-xs font-medium text-base-content/70 mt-2 mb-1';
      const label = document.createElement('span');
      label.className = 'truncate';
      label.textContent = file.path;
      label.title = file.absPath;
      const spinner = document.createElement('span');
      spinner.className = 'loading loading-spinner loading-xs text-base-content/40 shrink-0';
      header.appendChild(label);
      header.appendChild(spinner);
      const body = document.createElement('div');
      body.className = 'flex flex-wrap gap-2';
      section.appendChild(header);
      section.appendChild(body);
      this.treeEl.appendChild(section);
      sections.set(file.absPath, { body, spinner });
    }

    let done = 0;
    this.setStatus(`Scanning files… 0/${files.length}`);
    for (const file of files) {
      const result = await scanPartCatalogFile(file.absPath, ac.signal);
      if (ac.signal.aborted) {
        return;
      }
      done++;
      this.setStatus(`Scanning files… ${done}/${files.length}`);
      const section = sections.get(file.absPath)!;
      section.spinner.classList.add('hidden');
      this.renderFileResult(section.body, file, result);
    }
    this.setStatus('');
  }

  private renderFileResult(
    body: HTMLDivElement,
    file: CatalogFileEntry,
    result: CatalogScanResult | null,
  ): void {
    if (result === null) {
      const err = document.createElement('div');
      err.className = 'text-xs text-error';
      err.textContent = 'Scan failed.';
      body.appendChild(err);
      return;
    }
    if (result.parts.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'text-xs text-base-content/40';
      empty.textContent = 'No exported parts.';
      if (result.errors.length > 0) {
        empty.title = result.errors
          .map(e => (e.exportName ? `${e.exportName}: ${e.message}` : e.message))
          .join('\n');
        empty.textContent += ` (${result.errors.length} export${result.errors.length === 1 ? '' : 's'} skipped)`;
      }
      body.appendChild(empty);
      return;
    }
    for (const part of result.parts) {
      body.appendChild(this.buildPartTile(file, part));
    }
  }

  private buildPartTile(
    file: CatalogFileEntry,
    part: CatalogScanResult['parts'][number],
  ): HTMLButtonElement {
    const tile = document.createElement('button');
    tile.className = 'flex flex-col items-center gap-1 p-2 w-[104px] rounded-lg border border-base-content/10 '
      + 'hover:border-primary hover:bg-base-200 cursor-pointer transition-colors';
    tile.title = part.kind === 'factory'
      ? `Insert ${part.partName} — ${part.exportName}() with default arguments`
      : `Insert ${part.partName}`;

    const dataUrl = this.thumbs.render(part.objects, part.rootId);
    if (dataUrl) {
      const img = document.createElement('img');
      img.className = 'w-20 h-20 object-contain pointer-events-none';
      img.src = dataUrl;
      img.alt = part.partName;
      tile.appendChild(img);
    } else {
      const placeholder = document.createElement('div');
      placeholder.className = 'w-20 h-20 flex items-center justify-center text-base-content/25 text-2xl';
      placeholder.textContent = '∅';
      tile.appendChild(placeholder);
    }

    const name = document.createElement('span');
    name.className = 'text-xs text-base-content/90 truncate w-full text-center';
    name.textContent = part.partName;
    const exportLabel = document.createElement('span');
    exportLabel.className = 'text-[10px] text-base-content/50 truncate w-full text-center';
    exportLabel.textContent = part.kind === 'factory' ? `${part.exportName}()` : part.exportName;
    tile.appendChild(name);
    tile.appendChild(exportLabel);

    tile.addEventListener('click', () => void this.insert(file, part));
    return tile;
  }

  private async insert(
    file: CatalogFileEntry,
    part: CatalogScanResult['parts'][number],
  ): Promise<void> {
    if (this.inserting) {
      return;
    }
    this.inserting = true;
    this.setStatus(`Inserting ${part.partName}…`);
    const result = await insertCatalogPart(file.absPath, part.exportName, part.kind);
    this.inserting = false;
    if (result.success) {
      this.hide();
      return;
    }
    this.setStatus(result.reason ?? 'Insert failed.', true);
  }
}
