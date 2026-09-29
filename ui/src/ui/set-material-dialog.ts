import type { EngineClient } from '../engine-client';
import type { Material } from '../api';
import type { SceneObjectRender } from '../types';
import { ICON_CHECK, ICON_CLOSE } from './icons';

export interface SetMaterialDialogHandlers {
  /** Opens Settings → Materials; without it the dialog offers no Manage materials… link. */
  onManage?: () => void;
}

type Row = { id: string | null; label: string; material: Material | null; disabled?: boolean };

/**
 * The Set material… dialog for a part row: the merged materials in two
 * groups, the built-ins and the custom ones (the project's `fluidcad.json`
 * entries plus the user's global list from Settings → Materials), with a
 * filter box, the part's current material checked and pinned on top, and
 * **None** to take the `.material()` chain off. Apply dispatches the acked set-part-material
 * edit; a global material is copied into the project by the server before
 * the source names it. An id the list lacks shows as a checked, unpickable
 * "Unknown material" row so the user sees what the source says.
 */
export class SetMaterialDialog {
  private overlay: HTMLDivElement;
  private titleEl: HTMLElement;
  private subtitleEl: HTMLElement;
  private filterInput: HTMLInputElement;
  private listEl: HTMLDivElement;
  private applyBtn: HTMLButtonElement;
  private manageBtn: HTMLButtonElement;

  private part: SceneObjectRender | null = null;
  private current: string | null = null;
  private selected: string | null = null;
  private materials: Material[] = [];
  /**
   * Whether the merged list has arrived. Until it has, nothing is judged
   * against it: the current id is only "unknown" once a loaded list lacks
   * it, and a request that failed says so instead of pretending.
   */
  private listState: 'loading' | 'ready' | 'failed' = 'loading';

  constructor(container: HTMLElement, private client: EngineClient, private handlers: SetMaterialDialogHandlers = {}) {
    this.overlay = document.createElement('div');
    this.overlay.className = 'fixed inset-0 z-[300] bg-black/50 flex items-center justify-center hidden';
    this.overlay.setAttribute('role', 'dialog');
    this.overlay.setAttribute('aria-modal', 'true');
    this.overlay.setAttribute('aria-label', 'Set material');
    this.overlay.innerHTML = `
      <div data-role="box" class="w-[440px] max-w-[92vw] max-h-[85vh] bg-base-100 border border-base-content/10 rounded-lg p-5 shadow-[0_4px_24px_rgba(0,0,0,0.5)] flex flex-col">
        <div class="flex items-center justify-between mb-0.5">
          <h3 data-ref="title" class="text-sm font-medium text-base-content/90">Set material</h3>
          <button data-ref="close" type="button" class="btn btn-ghost btn-square btn-xs text-base-content/60" aria-label="Close">
            <span class="[&>svg]:size-4">${ICON_CLOSE}</span>
          </button>
        </div>
        <div data-ref="subtitle" class="text-[11px] text-base-content/50 mb-3 truncate"></div>
        <input data-ref="filter" type="search" class="input input-sm input-bordered w-full mb-2" placeholder="Filter by name or id" spellcheck="false" />
        <div data-ref="list" role="listbox" aria-label="Materials" class="overflow-y-auto min-h-[120px] max-h-[48vh] border border-base-content/10 rounded-md"></div>
        <div class="flex items-center gap-2 pt-3">
          <button data-ref="manage" type="button" class="btn btn-link btn-xs px-0 h-auto min-h-0 text-[11px] text-base-content/50 hidden">Manage materials…</button>
          <span class="flex-1"></span>
          <button data-ref="cancel" type="button" class="btn btn-ghost btn-sm">Cancel</button>
          <button data-ref="apply" type="button" class="btn btn-primary btn-sm" disabled>Apply</button>
        </div>
      </div>
    `;
    container.appendChild(this.overlay);

    const ref = <T extends HTMLElement>(name: string): T => this.overlay.querySelector<T>(`[data-ref="${name}"]`)!;
    this.titleEl = ref('title');
    this.subtitleEl = ref('subtitle');
    this.filterInput = ref('filter');
    this.listEl = ref('list');
    this.applyBtn = ref('apply');
    this.manageBtn = ref('manage');
    this.manageBtn.classList.toggle('hidden', !this.handlers.onManage);
    this.bindEvents();
  }

  get isOpen(): boolean {
    return !this.overlay.classList.contains('hidden');
  }

  /** Open for `part` (a part row): a fresh read of the merged list every time, since Settings may have written since. */
  open(part: SceneObjectRender): void {
    this.part = part;
    this.current = typeof part.object?.material === 'string' ? (part.object.material as string) : null;
    this.selected = this.current;
    this.materials = [];
    this.listState = 'loading';
    this.titleEl.textContent = 'Set material';
    this.subtitleEl.textContent = part.object?.name ? String(part.object.name) : part.name;
    this.filterInput.value = '';
    this.renderList();
    this.overlay.classList.remove('hidden');
    this.filterInput.focus();
    void this.load();
  }

  hide(): void {
    this.overlay.classList.add('hidden');
    this.part = null;
  }

  private async load(): Promise<void> {
    const materials = await this.client.getMaterials();
    if (!this.isOpen) {
      return;
    }
    // The engine answers null when the request failed (a server mid-restart,
    // a lost connection); an empty answer is impossible since the built-ins
    // are always listed.
    if (!materials || materials.length === 0) {
      this.listState = 'failed';
      this.renderList();
      return;
    }
    this.materials = materials;
    this.listState = 'ready';
    this.renderList();
  }

  private bindEvents(): void {
    const close = () => this.hide();
    this.overlay.querySelector('[data-ref="close"]')!.addEventListener('click', close);
    this.overlay.querySelector('[data-ref="cancel"]')!.addEventListener('click', close);
    this.overlay.addEventListener('mousedown', (e) => {
      if (e.target === this.overlay) {
        close();
      }
    });
    this.overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      } else if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) {
        e.preventDefault();
        this.apply();
      }
    });
    this.filterInput.addEventListener('input', () => this.renderList());
    this.applyBtn.addEventListener('click', () => this.apply());
    this.manageBtn.addEventListener('click', () => {
      this.hide();
      this.handlers.onManage?.();
    });
  }

  // ---------------------------------------------------------------------------
  // List
  // ---------------------------------------------------------------------------

  /**
   * The rows in display order: the part's current material pinned on top
   * (or its unknown id), None, then the two groups without it. The head
   * rows are always shown, whatever the filter.
   */
  private rows(): { group: string | null; rows: Row[] }[] {
    const filter = this.filterInput.value.trim().toLowerCase();
    const matches = (m: Material) => filter === '' || m.name.toLowerCase().includes(filter) || m.id.toLowerCase().includes(filter);
    const toRow = (m: Material): Row => ({ id: m.id, label: m.name, material: m });
    const byId = new Map(this.materials.map((m) => [m.id, m]));
    const head: Row[] = [];
    const currentMaterial = this.current !== null ? byId.get(this.current) : undefined;
    if (currentMaterial) {
      head.push(toRow(currentMaterial));
    } else if (this.listState === 'ready' && this.current !== null) {
      head.push({ id: this.current, label: `Unknown material: ${this.current}`, material: null, disabled: true });
    }
    head.push({ id: null, label: 'None', material: null });
    const listed = (m: Material) => m !== currentMaterial && matches(m);
    return [
      { group: null, rows: head },
      { group: 'Built-in', rows: this.materials.filter((m) => m.source === 'builtin' && listed(m)).map(toRow) },
      { group: 'Custom', rows: this.materials.filter((m) => m.source !== 'builtin' && listed(m)).map(toRow) },
    ];
  }

  private renderList(): void {
    this.listEl.innerHTML = '';
    if (this.listState !== 'ready') {
      this.renderListState();
      this.applyBtn.disabled = true;
      return;
    }
    let any = false;
    for (const { group, rows } of this.rows()) {
      if (rows.length === 0) {
        continue;
      }
      if (group !== null) {
        const header = document.createElement('div');
        header.className = 'px-3 pt-2 pb-1 text-[10px] uppercase tracking-wide text-base-content/40';
        header.textContent = group;
        this.listEl.appendChild(header);
      }
      for (const row of rows) {
        this.listEl.appendChild(this.buildRow(row));
        any = true;
      }
    }
    if (!any) {
      const empty = document.createElement('div');
      empty.className = 'text-[11px] text-base-content/40 text-center py-4';
      empty.dataset.ref = 'empty';
      empty.textContent = 'No material matches.';
      this.listEl.appendChild(empty);
    }
    this.applyBtn.disabled = this.selected === this.current;
  }

  /** The list while the merged list is on its way, or after the request failed. */
  private renderListState(): void {
    const note = document.createElement('div');
    note.className = 'text-[11px] text-base-content/50 text-center py-6';
    note.dataset.ref = this.listState;
    if (this.listState === 'loading') {
      note.textContent = 'Loading materials…';
    } else {
      note.textContent = 'Could not load the materials list.';
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'btn btn-link btn-xs px-1 h-auto min-h-0 text-[11px]';
      retry.dataset.ref = 'retry';
      retry.textContent = 'Retry';
      retry.addEventListener('click', () => {
        this.listState = 'loading';
        this.renderList();
        void this.load();
      });
      note.appendChild(retry);
    }
    this.listEl.appendChild(note);
  }

  private buildRow(row: Row): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'option');
    const selected = row.id === this.selected;
    button.setAttribute('aria-selected', String(selected));
    button.dataset.materialId = row.id ?? '';
    button.disabled = row.disabled === true;
    button.className = `w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs border-b border-base-content/[0.07] last:border-b-0 ${
      selected ? 'bg-primary/15' : 'hover:bg-base-content/[0.06]'
    } disabled:opacity-60`;

    const check = document.createElement('span');
    check.className = 'w-3.5 shrink-0 text-primary [&>svg]:size-3';
    check.innerHTML = row.id === this.current ? ICON_CHECK : '';
    check.title = row.id === this.current ? 'Current material' : '';
    button.appendChild(check);

    const label = document.createElement('span');
    label.className = 'flex-1 min-w-0 truncate text-base-content/90';
    label.textContent = row.label;
    button.appendChild(label);

    if (row.material) {
      if (row.material.source === 'project') {
        const tag = document.createElement('span');
        tag.className = 'text-[10px] text-base-content/40 shrink-0';
        tag.textContent = 'in project';
        tag.title = "Already in this project's fluidcad.json";
        button.appendChild(tag);
      }
      const density = document.createElement('span');
      density.className = 'text-[11px] text-base-content/50 shrink-0 tabular-nums';
      density.textContent = `${row.material.density} ${row.material.densityUnit}`;
      density.title = row.material.id;
      button.appendChild(density);
    }

    if (!row.disabled) {
      button.addEventListener('click', () => {
        this.selected = row.id;
        this.renderList();
      });
      button.addEventListener('dblclick', () => {
        this.selected = row.id;
        this.apply();
      });
    }
    return button;
  }

  private apply(): void {
    const part = this.part;
    if (!part || !part.sourceLocation || this.listState !== 'ready' || this.selected === this.current) {
      return;
    }
    void this.client.editor?.setPartMaterial(part.sourceLocation, this.selected);
    this.hide();
  }
}
