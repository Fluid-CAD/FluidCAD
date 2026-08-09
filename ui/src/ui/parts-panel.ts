// Parts panel — assembly mode left rail.
//
// Manual test plan:
//  1. Open a `.assembly.js` file with two `insert(...)` calls.
//     → See one row per insert with the part name.
//  2. Click a row → instance highlights in the viewport. Editor stays put.
//  3. Click 👁 → instance hides; click again → reappears.
//  4. Click ⋮ (or right-click the row) → menu shows Show in source,
//     Toggle grounded, Rename, Delete, each with its icon.
//  5. Toggle grounded on row B → ground glyph moves from row A (if previously
//     grounded) to row B; source updates accordingly. Toggling it again on
//     row B drops `.grounded()` and the glyph with it.
//  6. Rename → inline input commits on Enter or blur.
//
// Companion to timeline-panel.ts (part-design rail). Both are mounted on the
// same container and selected by ui/main.ts based on `sceneKind`.

import type { RenderedInstance } from '../types';
import {
  ICON_CHEVRON_RIGHT,
  ICON_CODE,
  ICON_CUBE,
  ICON_DOTS_VERTICAL,
  ICON_EYE,
  ICON_EYE_OFF,
  ICON_GROUND,
  ICON_PENCIL,
  ICON_TRASH,
} from './icons';

const SECTION_HEADER = 'flex items-center gap-2 px-3 py-2 panel-bg border border-base-content/10 rounded-md cursor-pointer select-none shrink-0';

export class PartsPanel {
  private panel: HTMLDivElement;
  private partsBody: HTMLDivElement;
  private jointsHost: HTMLDivElement;
  private instances: RenderedInstance[] = [];
  private selectedId: string | null = null;
  private partsExpanded = true;
  private loaded = false;
  private userHidden = false;
  private activeDropdown: HTMLDivElement | null = null;
  private dropdownCleanup: (() => void) | null = null;
  private inlineRenameId: string | null = null;

  private onSelectInstance: (instanceId: string) => void;
  private onToggleVisibility: (instanceId: string, visible: boolean) => void;
  private onShowInSource: (instanceId: string) => void;
  private onSetGround: (instanceId: string, grounded: boolean) => void;
  private onRename: (instanceId: string, newName: string) => void;
  private onDeleteInstance: (instanceId: string) => void;

  constructor(
    container: HTMLElement,
    onSelectInstance: (instanceId: string) => void,
    onToggleVisibility: (instanceId: string, visible: boolean) => void,
    onShowInSource: (instanceId: string) => void,
    /** Sets (`grounded: true`) or clears (`false`) the instance's ground. */
    onSetGround: (instanceId: string, grounded: boolean) => void,
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
    // Docked below the top bars (top bar + navbar ≈ 92px) with breathing
    // room, mirroring the part-design TimelinePanel — the TopBar owns the
    // logo and file name for both rails.
    this.panel.className = 'absolute left-6 top-[116px] bottom-6 w-[220px] z-[99] flex flex-col gap-1 select-none hidden';
    container.appendChild(this.panel);

    const partsHeader = document.createElement('div');
    partsHeader.className = SECTION_HEADER;
    partsHeader.innerHTML = `
      <span data-ref="chevron" class="flex items-center justify-center w-5 h-5 opacity-50 transition-transform rotate-90">${ICON_CHEVRON_RIGHT}</span>
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

    // Slot where the joints panel mounts itself, so both sections share one
    // left-rail column under the top bars.
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

  update(instances: RenderedInstance[]): void {
    this.instances = instances;
    if (!this.loaded) {
      this.loaded = true;
      this.syncVisibility();
    }
    const countLabel = this.panel.querySelector<HTMLSpanElement>('[data-ref="parts-count"]')!;
    countLabel.textContent = instances.length > 0 ? String(instances.length) : '';
    this.renderRows();
  }

  /**
   * Toggle the whole assembly rail (driven by the top-bar hamburger, like
   * the part-design timeline). The joints panel mounts inside this panel's
   * column, so one toggle covers both sections.
   */
  togglePanel(): void {
    this.userHidden = !this.userHidden;
    this.syncVisibility();
  }

  private syncVisibility(): void {
    this.panel.classList.toggle('hidden', !(this.loaded && !this.userHidden));
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
      const groundSlot = `<span class="relative shrink-0 inline-flex items-center justify-center w-4 h-4 text-base-content/60 [&>svg]:size-4">${ICON_CUBE}${groundOverlay}</span>`;
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
          <button class="opacity-0 group-hover:opacity-100 btn btn-ghost btn-square btn-xs text-base-content/40 hover:text-base-content/70 shrink-0" data-dots="${inst.instanceId}">${ICON_DOTS_VERTICAL}</button>
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
      row.addEventListener('contextmenu', (e) => {
        if ((e.target as HTMLElement).closest('[data-rename-input]')) {
          return;
        }
        e.preventDefault();
        const panelRect = this.panel.getBoundingClientRect();
        this.showDropdown(row.dataset.instanceId!, {
          top: e.clientY - panelRect.top,
          left: e.clientX - panelRect.left,
        });
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
        const rect = btn.getBoundingClientRect();
        const panelRect = this.panel.getBoundingClientRect();
        this.showDropdown(btn.dataset.dots!, {
          top: rect.bottom - panelRect.top + 2,
          left: rect.left - panelRect.left - 140,
        }, btn);
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

  /**
   * The row menu, opened either under the ⋮ button (`anchor` given) or at the
   * pointer on a row right-click. `position` is relative to the panel, which
   * hosts the menu so it survives a row re-render.
   */
  private showDropdown(
    instanceId: string,
    position: { top: number; left: number },
    anchor?: HTMLElement,
  ): void {
    this.closeDropdown();
    const inst = this.instances.find(i => i.instanceId === instanceId);
    if (!inst) {
      return;
    }

    const dropdown = document.createElement('div');
    dropdown.className = 'absolute z-[200] panel-bg border border-base-content/10 rounded-md shadow-[0_4px_12px_rgba(0,0,0,0.4)]';
    dropdown.style.top = `${position.top}px`;
    dropdown.style.left = `${position.left}px`;

    dropdown.innerHTML = `
      <ul class="menu menu-xs p-1 min-w-[160px]">
        ${PartsPanel.menuItem('show-in-source', ICON_CODE, 'Show in source')}
        ${PartsPanel.menuItem('set-ground', ICON_GROUND, 'Toggle grounded', inst.grounded ? 'text-warning' : '')}
        ${PartsPanel.menuItem('rename', ICON_PENCIL, 'Rename')}
        ${PartsPanel.menuItem('delete', ICON_TRASH, 'Delete', 'text-error')}
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
      // Toggle: a grounded instance drops its `.grounded()` again, rather than
      // re-writing the one it already has.
      this.onSetGround(instanceId, !inst.grounded);
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
      if (!dropdown.contains(e.target as Node) && !anchor?.contains(e.target as Node)) {
        this.closeDropdown();
      }
    };
    // A right-click elsewhere dismisses too — the row handler that opens the
    // next menu runs first (and clears this listener), so the fresh menu stays.
    setTimeout(() => {
      document.addEventListener('click', onClickOutside);
      document.addEventListener('contextmenu', onClickOutside);
    }, 0);
    this.dropdownCleanup = () => {
      document.removeEventListener('click', onClickOutside);
      document.removeEventListener('contextmenu', onClickOutside);
    };
  }

  /** One icon + label menu row, matching the timeline panel's context menu. */
  private static menuItem(action: string, icon: string, label: string, extraClass = ''): string {
    return `<li><button data-action="${action}" class="flex items-center gap-2 ${extraClass}">`
      + `<span class="flex items-center justify-center w-4 h-4 shrink-0 [&>svg]:size-3.5">${icon}</span>`
      + `<span>${label}</span>`
      + `</button></li>`;
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
