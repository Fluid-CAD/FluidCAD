// Parts panel — assembly mode left rail.
//
// Manual test plan:
//  1. Open a `.assembly.js` file with two `insert(...)` calls.
//     → See one row per insert with the part name.
//  2. Click a row → instance highlights in the viewport. Editor stays put.
//  3. Click 👁 → instance hides; click again → reappears.
//  4. Click ⋮ → menu shows Show in source, Set as ground, Rename, Delete.
//  5. Set as ground on row B → ground glyph moves from row A (if previously
//     grounded) to row B; source updates accordingly.
//  6. Rename → inline input commits on Enter or blur.
//
// Companion to timeline-panel.ts (part-design rail). Both are mounted on the
// same container and selected by ui/main.ts based on `sceneKind`.

import type { RenderedInstance } from '../types';
import { ICON_EYE, ICON_EYE_OFF, ICON_GROUND } from './icons';

const SECTION_HEADER = 'flex items-center gap-2 px-3 py-2 panel-bg border border-base-content/10 rounded-md cursor-pointer select-none shrink-0';
const CHEVRON_SVG = '<svg width="14" height="14" viewBox="0 0 10 10" fill="currentColor"><path d="M3 1l5 4-5 4z"/></svg>';
const CUBE_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>';
const DOTS_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>';

export class PartsPanel {
  private panel: HTMLDivElement;
  private fileLabel: HTMLSpanElement;
  private partsBody: HTMLDivElement;
  private jointsHost: HTMLDivElement;
  private instances: RenderedInstance[] = [];
  private selectedId: string | null = null;
  private partsExpanded = true;
  private loaded = false;
  private activeDropdown: HTMLDivElement | null = null;
  private dropdownCleanup: (() => void) | null = null;
  private inlineRenameId: string | null = null;

  private onSelectInstance: (instanceId: string) => void;
  private onToggleVisibility: (instanceId: string, visible: boolean) => void;
  private onShowInSource: (instanceId: string) => void;
  private onSetGround: (instanceId: string) => void;
  private onRename: (instanceId: string, newName: string) => void;
  private onDeleteInstance: (instanceId: string) => void;

  constructor(
    container: HTMLElement,
    onSelectInstance: (instanceId: string) => void,
    onToggleVisibility: (instanceId: string, visible: boolean) => void,
    onShowInSource: (instanceId: string) => void,
    onSetGround: (instanceId: string) => void,
    onRename: (instanceId: string, newName: string) => void,
    onDeleteInstance: (instanceId: string) => void,
  ) {
    this.onSelectInstance = onSelectInstance;
    this.onToggleVisibility = onToggleVisibility;
    this.onShowInSource = onShowInSource;
    this.onSetGround = onSetGround;
    this.onRename = onRename;
    this.onDeleteInstance = onDeleteInstance;

    this.panel = document.createElement('div');
    this.panel.className = 'absolute left-6 top-6 bottom-6 w-[220px] z-[99] flex flex-col gap-1 select-none hidden';
    container.appendChild(this.panel);

    const logoRow = document.createElement('div');
    logoRow.className = 'flex items-center gap-1.5 px-1 pb-1 shrink-0';
    logoRow.innerHTML = `<img src="/logo.png" alt="FluidCAD" class="h-6 w-auto opacity-70" /><span class="text-[18px] font-bold text-base-content/70">FluidCAD</span>`;
    this.panel.appendChild(logoRow);

    const fileRow = document.createElement('div');
    fileRow.className = 'flex items-center gap-2 px-1 pb-1 shrink-0';
    fileRow.innerHTML = `
      <span class="text-base-content/50 [&>svg]:size-4">${CUBE_SVG}</span>
      <span data-ref="filename" class="text-base text-base-content/70 truncate"></span>
    `;
    this.panel.appendChild(fileRow);
    this.fileLabel = fileRow.querySelector('[data-ref="filename"]')!;

    const partsHeader = document.createElement('div');
    partsHeader.className = SECTION_HEADER;
    partsHeader.innerHTML = `
      <span data-ref="chevron" class="flex items-center justify-center w-5 h-5 opacity-50 transition-transform rotate-90">${CHEVRON_SVG}</span>
      <span class="text-sm font-medium text-base-content/70">Parts</span>
      <span data-ref="parts-count" class="text-xs text-base-content/40 tabular-nums"></span>
    `;
    this.panel.appendChild(partsHeader);

    this.partsBody = document.createElement('div');
    this.partsBody.className = 'py-1 overflow-y-auto min-h-0';
    this.panel.appendChild(this.partsBody);

    partsHeader.addEventListener('click', () => {
      this.partsExpanded = !this.partsExpanded;
      this.partsBody.classList.toggle('hidden', !this.partsExpanded);
      const chevron = partsHeader.querySelector('[data-ref="chevron"]')!;
      chevron.classList.toggle('rotate-90', this.partsExpanded);
    });

    // Slot where the joints panel mounts itself; lets the rails share one
    // logo+filename header instead of stacking two.
    this.jointsHost = document.createElement('div');
    this.jointsHost.className = 'flex flex-col gap-1 min-h-0 flex-1';
    this.panel.appendChild(this.jointsHost);
  }

  /**
   * Slot in which the joints panel appends its header + body.
   * Returned so PartsPanel can own the overall left-rail layout.
   */
  getJointsHost(): HTMLElement {
    return this.jointsHost;
  }

  update(instances: RenderedInstance[], absPath: string): void {
    this.instances = instances;
    if (absPath) {
      const fileName = absPath.split('/').pop() || absPath;
      this.fileLabel.textContent = fileName;
    }
    if (!this.loaded) {
      this.loaded = true;
      this.panel.classList.remove('hidden');
    }
    const countLabel = this.panel.querySelector<HTMLSpanElement>('[data-ref="parts-count"]')!;
    countLabel.textContent = instances.length > 0 ? String(instances.length) : '';
    this.renderRows();
  }

  setSelected(instanceId: string | null): void {
    if (this.selectedId === instanceId) {
      return;
    }
    this.selectedId = instanceId;
    this.renderRows();
  }

  dispose(): void {
    this.closeDropdown();
    this.panel.remove();
  }

  private renderRows(): void {
    if (this.instances.length === 0) {
      this.partsBody.innerHTML = `
        <div class="px-3 py-2 text-xs text-base-content/40 italic">
          No instances yet — call <code>insert(part)</code> in the assembly file.
        </div>
      `;
      return;
    }

    let html = '';
    for (const inst of this.instances) {
      const selected = this.selectedId === inst.instanceId;
      const selectedClass = selected ? ' bg-primary/10' : '';
      const groundOverlay = inst.grounded
        ? `<span class="absolute -bottom-1 -right-1 text-warning leading-none [&>svg]:size-3.5" title="Grounded">${ICON_GROUND}</span>`
        : '';
      const groundSlot = `<span class="relative shrink-0 inline-flex items-center justify-center w-4 h-4 text-base-content/60 [&>svg]:size-4">${CUBE_SVG}${groundOverlay}</span>`;
      const eyeIcon = inst.visible ? ICON_EYE : ICON_EYE_OFF;
      const eyeVisibility = inst.visible
        ? 'opacity-0 group-hover:opacity-100 text-base-content/40'
        : 'opacity-100 text-base-content/70';
      const nameOrInput = this.inlineRenameId === inst.instanceId
        ? `<input data-rename-input="${inst.instanceId}" value="${escapeAttr(inst.name)}" class="bg-base-100 border border-base-content/20 rounded px-1 py-0 text-sm flex-1 min-w-0" />`
        : `<span class="truncate">${escapeHtml(inst.name)}</span>`;
      html += `
        <div class="group flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-base-content/[0.06] text-sm text-base-content/80${selectedClass}" data-instance-id="${inst.instanceId}">
          ${groundSlot}
          ${nameOrInput}
          <button class="ml-auto btn btn-ghost btn-square btn-xs ${eyeVisibility} hover:text-base-content/70 shrink-0 [&>svg]:size-3.5" data-eye="${inst.instanceId}">${eyeIcon}</button>
          <button class="opacity-0 group-hover:opacity-100 btn btn-ghost btn-square btn-xs text-base-content/40 hover:text-base-content/70 shrink-0" data-dots="${inst.instanceId}">${DOTS_SVG}</button>
        </div>
      `;
    }
    this.partsBody.innerHTML = html;

    this.partsBody.querySelectorAll<HTMLElement>('[data-instance-id]').forEach((row) => {
      row.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        if (target.closest('[data-eye]') || target.closest('[data-dots]') || target.closest('[data-rename-input]')) {
          return;
        }
        const id = row.dataset.instanceId!;
        this.selectedId = id;
        this.renderRows();
        this.onSelectInstance(id);
      });
    });

    this.partsBody.querySelectorAll<HTMLElement>('[data-eye]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.dataset.eye!;
        const inst = this.instances.find(i => i.instanceId === id);
        if (!inst) return;
        inst.visible = !inst.visible;
        this.onToggleVisibility(id, inst.visible);
        this.renderRows();
      });
    });

    this.partsBody.querySelectorAll<HTMLElement>('[data-dots]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.showDropdown(btn, btn.dataset.dots!);
      });
    });

    if (this.inlineRenameId) {
      const input = this.partsBody.querySelector<HTMLInputElement>(`[data-rename-input="${this.inlineRenameId}"]`);
      if (input) {
        input.focus();
        input.select();
        const commit = () => {
          const id = this.inlineRenameId!;
          const value = input.value.trim();
          this.inlineRenameId = null;
          if (value.length > 0) {
            this.onRename(id, value);
          } else {
            this.renderRows();
          }
        };
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            this.inlineRenameId = null;
            this.renderRows();
          }
        });
        input.addEventListener('blur', commit);
        input.addEventListener('click', (e) => e.stopPropagation());
      }
    }
  }

  private showDropdown(anchor: HTMLElement, instanceId: string): void {
    this.closeDropdown();

    const dropdown = document.createElement('div');
    dropdown.className = 'absolute z-[200] panel-bg border border-base-content/10 rounded-md shadow-[0_4px_12px_rgba(0,0,0,0.4)]';

    const rect = anchor.getBoundingClientRect();
    const panelRect = this.panel.getBoundingClientRect();
    dropdown.style.top = `${rect.bottom - panelRect.top + 2}px`;
    dropdown.style.left = `${rect.left - panelRect.left - 140}px`;

    dropdown.innerHTML = `
      <ul class="menu menu-xs p-1 min-w-[160px]">
        <li><button data-action="show-in-source">Show in source</button></li>
        <li><button data-action="set-ground">Set as ground</button></li>
        <li><button data-action="rename">Rename</button></li>
        <li><button data-action="delete" class="text-error">Delete</button></li>
      </ul>
    `;

    this.panel.appendChild(dropdown);
    this.activeDropdown = dropdown;

    dropdown.querySelector('[data-action="show-in-source"]')!.addEventListener('click', () => {
      this.closeDropdown();
      this.onShowInSource(instanceId);
    });
    dropdown.querySelector('[data-action="set-ground"]')!.addEventListener('click', () => {
      this.closeDropdown();
      this.onSetGround(instanceId);
    });
    dropdown.querySelector('[data-action="rename"]')!.addEventListener('click', () => {
      this.closeDropdown();
      this.inlineRenameId = instanceId;
      this.renderRows();
    });
    dropdown.querySelector('[data-action="delete"]')!.addEventListener('click', () => {
      this.closeDropdown();
      this.onDeleteInstance(instanceId);
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

function escapeAttr(text: string): string {
  return escapeHtml(text).replace(/"/g, '&quot;');
}
