// Joints panel — assembly mode left rail, mounted under the parts panel.
//
// Manual test plan:
//  1. Open a `.assembly.js` file with no `mate(...)` calls →
//     "No joints yet" empty state.
//  2. Phase 06+: each `mate(...)` call appears as a row.
//  3. Click a row (when populated) → both connectors highlight in viewport.
//  4. ⋮ menu offers Suppress, Delete, Show in source.
//
// In phase 04 mates aren't created yet, so this panel only exercises the
// empty state. The real row rendering and click-to-highlight wiring lands
// alongside `mate()` in phase 06+.

import type { SerializedAssemblyMate, RenderedInstance } from '../types';

const SECTION_HEADER = 'flex items-center gap-2 px-3 py-2 panel-bg border border-base-content/10 rounded-md cursor-pointer select-none shrink-0';
const CHEVRON_SVG = '<svg width="14" height="14" viewBox="0 0 10 10" fill="currentColor"><path d="M3 1l5 4-5 4z"/></svg>';
const DOTS_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>';

const STATUS_COLORS: Record<SerializedAssemblyMate['status'], string> = {
  satisfied: 'bg-success',
  redundant: 'bg-warning',
  inconsistent: 'bg-error',
};

export class JointsPanel {
  private header: HTMLDivElement;
  private body: HTMLDivElement;
  private mates: SerializedAssemblyMate[] = [];
  private instancesById = new Map<string, RenderedInstance>();
  private expanded = true;
  private activeDropdown: HTMLDivElement | null = null;
  private dropdownCleanup: (() => void) | null = null;

  private onSelectMate: (mateId: string) => void;
  private onShowInSource: (mateId: string) => void;
  private onSuppress: (mateId: string) => void;
  private onDelete: (mateId: string) => void;

  constructor(
    host: HTMLElement,
    onSelectMate: (mateId: string) => void,
    onShowInSource: (mateId: string) => void,
    onSuppress: (mateId: string) => void,
    onDelete: (mateId: string) => void,
  ) {
    this.onSelectMate = onSelectMate;
    this.onShowInSource = onShowInSource;
    this.onSuppress = onSuppress;
    this.onDelete = onDelete;

    this.header = document.createElement('div');
    this.header.className = SECTION_HEADER;
    this.header.innerHTML = `
      <span data-ref="chevron" class="flex items-center justify-center w-5 h-5 opacity-50 transition-transform rotate-90">${CHEVRON_SVG}</span>
      <span class="text-sm font-medium text-base-content/70">Joints</span>
      <span data-ref="joints-count" class="text-xs text-base-content/40 tabular-nums"></span>
    `;
    host.appendChild(this.header);

    this.body = document.createElement('div');
    this.body.className = 'py-1 overflow-y-auto min-h-0 flex-1';
    host.appendChild(this.body);

    this.header.addEventListener('click', () => {
      this.expanded = !this.expanded;
      this.body.classList.toggle('hidden', !this.expanded);
      const chevron = this.header.querySelector('[data-ref="chevron"]')!;
      chevron.classList.toggle('rotate-90', this.expanded);
    });

    this.renderRows();
  }

  update(mates: SerializedAssemblyMate[], instances: RenderedInstance[]): void {
    this.mates = mates;
    this.instancesById.clear();
    for (const inst of instances) {
      this.instancesById.set(inst.instanceId, inst);
    }
    const countLabel = this.header.querySelector<HTMLSpanElement>('[data-ref="joints-count"]')!;
    countLabel.textContent = mates.length > 0 ? String(mates.length) : '';
    this.renderRows();
  }

  dispose(): void {
    this.closeDropdown();
    this.header.remove();
    this.body.remove();
  }

  private renderRows(): void {
    if (this.mates.length === 0) {
      this.body.innerHTML = `
        <div class="px-3 py-2 text-xs text-base-content/40 italic">
          No joints yet — define mates with <code>mate(...)</code>.
        </div>
      `;
      return;
    }

    let html = '';
    for (const mate of this.mates) {
      const aName = this.instancesById.get(mate.connectorA.instanceId)?.name ?? '?';
      const bName = this.instancesById.get(mate.connectorB.instanceId)?.name ?? '?';
      const dotColor = STATUS_COLORS[mate.status];
      html += `
        <div class="group flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-base-content/[0.06] text-base-content/80" data-mate-id="${mate.mateId}">
          <span class="shrink-0 inline-block w-2 h-2 rounded-full ${dotColor}"></span>
          <div class="flex-1 min-w-0 flex flex-col leading-tight">
            <span class="text-sm">${escapeHtml(mate.type)}</span>
            <span class="text-[10px] text-base-content/50 truncate">${escapeHtml(aName)}</span>
            <span class="text-[10px] text-base-content/50 truncate">${escapeHtml(bName)}</span>
          </div>
          <button class="opacity-0 group-hover:opacity-100 btn btn-ghost btn-square btn-xs text-base-content/40 hover:text-base-content/70 shrink-0" data-dots="${mate.mateId}">${DOTS_SVG}</button>
        </div>
      `;
    }
    this.body.innerHTML = html;

    this.body.querySelectorAll<HTMLElement>('[data-mate-id]').forEach((row) => {
      row.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        if (target.closest('[data-dots]')) return;
        this.onSelectMate(row.dataset.mateId!);
      });
    });

    this.body.querySelectorAll<HTMLElement>('[data-dots]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.showDropdown(btn, btn.dataset.dots!);
      });
    });
  }

  private showDropdown(anchor: HTMLElement, mateId: string): void {
    this.closeDropdown();

    const dropdown = document.createElement('div');
    dropdown.className = 'absolute z-[200] panel-bg border border-base-content/10 rounded-md shadow-[0_4px_12px_rgba(0,0,0,0.4)]';

    const rect = anchor.getBoundingClientRect();
    const hostRect = (this.body.parentElement as HTMLElement).getBoundingClientRect();
    dropdown.style.top = `${rect.bottom - hostRect.top + 2}px`;
    dropdown.style.left = `${rect.left - hostRect.left - 140}px`;

    dropdown.innerHTML = `
      <ul class="menu menu-xs p-1 min-w-[160px]">
        <li><button data-action="show-in-source">Show in source</button></li>
        <li><button data-action="suppress">Suppress</button></li>
        <li><button data-action="delete" class="text-error">Delete</button></li>
      </ul>
    `;

    (this.body.parentElement as HTMLElement).appendChild(dropdown);
    this.activeDropdown = dropdown;

    dropdown.querySelector('[data-action="show-in-source"]')!.addEventListener('click', () => {
      this.closeDropdown();
      this.onShowInSource(mateId);
    });
    dropdown.querySelector('[data-action="suppress"]')!.addEventListener('click', () => {
      this.closeDropdown();
      this.onSuppress(mateId);
    });
    dropdown.querySelector('[data-action="delete"]')!.addEventListener('click', () => {
      this.closeDropdown();
      this.onDelete(mateId);
    });

    const onClickOutside = (e: MouseEvent) => {
      if (!dropdown.contains(e.target as Node) && !anchor.contains(e.target as Node)) {
        this.closeDropdown();
      }
    };
    setTimeout(() => document.addEventListener('click', onClickOutside), 0);
    this.dropdownCleanup = () => document.removeEventListener('click', onClickOutside);
  }

  private closeDropdown(): void {
    if (this.activeDropdown) {
      this.activeDropdown.remove();
      this.activeDropdown = null;
    }
    if (this.dropdownCleanup) {
      this.dropdownCleanup();
      this.dropdownCleanup = null;
    }
  }
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
