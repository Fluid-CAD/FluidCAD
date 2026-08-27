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
//  7. Insert a sub-assembly (`insert(xAxis())`) → its instances group under a
//     collapsible occurrence header carrying the assembly's name. The header's
//     menu edits the occurrence's own insert() statement (ground/rename/
//     delete); member rows only offer Show in source — their statements live
//     in the sub-assembly's file, where an edit would hit every occurrence.
//  8. Header 👁 hides/shows all member instances at once.
//
// Companion to timeline-panel.ts (part-design rail). Both are mounted on the
// same container and selected by ui/main.ts based on `sceneKind`.

import type { RenderedInstance, SerializedAssemblyOccurrence } from '../types';
import {
  ICON_ADJUSTMENTS,
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

/** Statement-editing actions on a top-level occurrence's own insert() chain. */
export type OccurrenceHandlers = {
  onShowInSource: (occurrenceId: string) => void;
  /** Sets (`grounded: true`) or clears (`false`) the occurrence's ground. */
  onSetGround: (occurrenceId: string, grounded: boolean) => void;
  onRename: (occurrenceId: string, newName: string) => void;
  onDelete: (occurrenceId: string) => void;
};

type RenameTarget = { kind: 'instance' | 'occurrence'; id: string };

export interface PartsPanelOptions {
  /**
   * A host that cannot edit source (the browser viewer): rows keep select /
   * visibility, and lose the ⋮ menu, the context menu and inline rename —
   * every action there rewrites an insert() statement.
   */
  readOnly?: boolean;
}

export class PartsPanel {
  private panel: HTMLDivElement;
  private partsBody: HTMLDivElement;
  private jointsHost: HTMLDivElement;
  private instances: RenderedInstance[] = [];
  private occurrences: SerializedAssemblyOccurrence[] = [];
  private selectedId: string | null = null;
  private partsExpanded = true;
  private loaded = false;
  private userHidden = false;
  private activeDropdown: HTMLDivElement | null = null;
  private dropdownCleanup: (() => void) | null = null;
  private inlineRename: RenameTarget | null = null;
  private collapsedGroups = new Set<string>();

  private onSelectInstance: (instanceId: string) => void;
  private onToggleVisibility: (instanceId: string, visible: boolean) => void;
  private onShowInSource: (instanceId: string) => void;
  private onSetGround: (instanceId: string, grounded: boolean) => void;
  private onRename: (instanceId: string, newName: string) => void;
  private onDeleteInstance: (instanceId: string) => void;
  private occurrenceHandlers: OccurrenceHandlers | null;
  private onEditParams: ((kind: 'instance' | 'occurrence', id: string) => void) | null;
  private readonly readOnly: boolean;

  constructor(
    container: HTMLElement,
    onSelectInstance: (instanceId: string) => void,
    onToggleVisibility: (instanceId: string, visible: boolean) => void,
    onShowInSource: (instanceId: string) => void,
    /** Sets (`grounded: true`) or clears (`false`) the instance's ground. */
    onSetGround: (instanceId: string, grounded: boolean) => void,
    onRename: (instanceId: string, newName: string) => void,
    onDeleteInstance: (instanceId: string) => void,
    occurrenceHandlers?: OccurrenceHandlers,
    onEditParams?: (kind: 'instance' | 'occurrence', id: string) => void,
    options: PartsPanelOptions = {},
  ) {
    this.readOnly = options.readOnly === true;
    this.onSelectInstance = onSelectInstance;
    this.onToggleVisibility = onToggleVisibility;
    this.onShowInSource = onShowInSource;
    this.onSetGround = onSetGround;
    this.onRename = onRename;
    this.onDeleteInstance = onDeleteInstance;
    this.occurrenceHandlers = occurrenceHandlers ?? null;
    this.onEditParams = onEditParams ?? null;

    this.panel = document.createElement('div');
    // Docked exactly like the part-design timeline: in the scene's left
    // gutter (--fluidcad-panel-left already clears the rail and the editor
    // pane), below the host chrome. The TopBar owns the logo and file name
    // for both rails.
    this.panel.className = 'absolute left-[calc(var(--fluidcad-panel-left,0px)+1.5rem)] top-[calc(var(--fluidcad-chrome-top,104px)+12px)] bottom-6 w-[220px] z-[99] flex flex-col gap-1 select-none hidden';
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

  update(instances: RenderedInstance[], occurrences: SerializedAssemblyOccurrence[] = []): void {
    this.instances = instances;
    this.occurrences = occurrences;
    for (const id of [...this.collapsedGroups]) {
      if (!occurrences.some(o => o.occurrenceId === id)) {
        this.collapsedGroups.delete(id);
      }
    }
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

  /** What the top-bar menu's checkmark reflects (same contract as the timeline). */
  get isPanelVisible(): boolean {
    return this.loaded && !this.userHidden;
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

  /** Top-level occurrences (parentPath ''), in creation order. */
  private topLevelOccurrences(): SerializedAssemblyOccurrence[] {
    return this.occurrences.filter(o => o.parentPath === '');
  }

  /**
   * All instances belonging to a top-level occurrence, nested sub-assemblies
   * flattened in (v1 renders one level of grouping). Path-segment prefix
   * match — a plain startsWith('asm-1') would also swallow 'asm-10/...'.
   */
  private membersOf(occurrenceId: string): RenderedInstance[] {
    return this.instances.filter(i =>
      i.owner === occurrenceId || (i.owner ?? '').startsWith(`${occurrenceId}/`),
    );
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

    // Scene order, one level of grouping: root-owned instances render as
    // plain rows; the first member of a top-level occurrence emits the whole
    // group (header + members).
    let html = '';
    const emittedGroups = new Set<string>();
    for (const inst of this.instances) {
      const owner = inst.owner ?? '';
      if (owner === '') {
        html += this.instanceRowHtml(inst, false);
        continue;
      }
      const groupId = owner.split('/')[0];
      if (emittedGroups.has(groupId)) {
        continue;
      }
      emittedGroups.add(groupId);
      html += this.groupHtml(groupId);
    }
    // Occurrences with no instances (empty or failed bodies) still get their
    // header so ground/rename/delete stay reachable.
    for (const occ of this.topLevelOccurrences()) {
      if (!emittedGroups.has(occ.occurrenceId)) {
        emittedGroups.add(occ.occurrenceId);
        html += this.groupHtml(occ.occurrenceId);
      }
    }
    this.partsBody.innerHTML = html;

    this.bindInstanceRows();
    this.bindGroupHeaders();
    this.bindRenameInput();
  }

  private groupHtml(occurrenceId: string): string {
    const occ = this.occurrences.find(o => o.occurrenceId === occurrenceId);
    if (!occ) {
      // Owner path without an occurrence record (engine mismatch) — render
      // the members as plain rows rather than dropping them.
      return this.membersOf(occurrenceId).map(i => this.instanceRowHtml(i, false)).join('');
    }
    const members = this.membersOf(occurrenceId);
    const collapsed = this.collapsedGroups.has(occurrenceId);
    const allHidden = members.length > 0 && members.every(m => !m.visible);
    const groundOverlay = occ.grounded
      ? `<span class="absolute -bottom-1 -right-1 text-warning leading-none [&>svg]:size-3.5" title="Grounded">${ICON_GROUND}</span>`
      : '';
    const eyeIcon = allHidden ? ICON_EYE_OFF : ICON_EYE;
    const eyeVisibility = allHidden
      ? 'opacity-100 text-base-content/70'
      : 'opacity-0 group-hover:opacity-100 text-base-content/40';
    const nameOrInput = this.inlineRename?.kind === 'occurrence' && this.inlineRename.id === occurrenceId
      ? `<input data-rename-input="occurrence" value="${escapeAttr(occ.name)}" class="bg-base-100 border border-base-content/20 rounded px-1 py-0 text-sm flex-1 min-w-0" />`
      : `<span class="truncate font-medium">${escapeHtml(occ.name)}</span>`;
    let html = `
      <div class="group flex items-center gap-1.5 px-2 py-1.5 cursor-pointer hover:bg-base-content/[0.06] text-sm text-base-content/80" data-occurrence-id="${occurrenceId}">
        <span data-ref="chevron" class="flex items-center justify-center w-4 h-4 opacity-50 transition-transform${collapsed ? '' : ' rotate-90'}">${ICON_CHEVRON_RIGHT}</span>
        <span class="relative shrink-0 inline-flex items-center justify-center w-4 h-4 text-base-content/60 [&>svg]:size-4">${ICON_CUBE}${groundOverlay}</span>
        ${nameOrInput}
        <span class="text-xs text-base-content/40 tabular-nums shrink-0">${members.length}</span>
        <button class="ml-auto btn btn-ghost btn-square btn-xs ${eyeVisibility} hover:text-base-content/70 shrink-0 [&>svg]:size-3.5" data-group-eye="${occurrenceId}">${eyeIcon}</button>
        ${this.dotsButtonHtml('data-group-dots', occurrenceId)}
      </div>
    `;
    if (!collapsed) {
      html += members.map(m => this.instanceRowHtml(m, true)).join('');
    }
    return html;
  }

  private instanceRowHtml(inst: RenderedInstance, indented: boolean): string {
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
    const nameOrInput = this.inlineRename?.kind === 'instance' && this.inlineRename.id === inst.instanceId
      ? `<input data-rename-input="instance" value="${escapeAttr(inst.name)}" class="bg-base-100 border border-base-content/20 rounded px-1 py-0 text-sm flex-1 min-w-0" />`
      : `<span class="truncate">${escapeHtml(inst.name)}</span>`;
    const padding = indented ? 'pl-8 pr-3' : 'px-3';
    return `
      <div class="group flex items-center gap-2 ${padding} py-1.5 cursor-pointer hover:bg-base-content/[0.06] text-sm text-base-content/80${selectedClass}" data-instance-id="${inst.instanceId}">
        ${groundSlot}
        ${nameOrInput}
        <button class="ml-auto btn btn-ghost btn-square btn-xs ${eyeVisibility} hover:text-base-content/70 shrink-0 [&>svg]:size-3.5" data-eye="${inst.instanceId}">${eyeIcon}</button>
        ${this.dotsButtonHtml('data-dots', inst.instanceId)}
      </div>
    `;
  }

  /** The ⋮ menu button — omitted entirely on a read-only host (its every item edits source). */
  private dotsButtonHtml(attr: 'data-dots' | 'data-group-dots', id: string): string {
    if (this.readOnly) {
      return '';
    }
    return `<button class="opacity-0 group-hover:opacity-100 btn btn-ghost btn-square btn-xs text-base-content/40 hover:text-base-content/70 shrink-0" ${attr}="${id}">${ICON_DOTS_VERTICAL}</button>`;
  }

  private bindInstanceRows(): void {
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
  }

  private bindGroupHeaders(): void {
    this.partsBody.querySelectorAll<HTMLElement>('[data-occurrence-id]').forEach((row) => {
      row.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        if (target.closest('[data-group-eye]') || target.closest('[data-group-dots]') || target.closest('[data-rename-input]')) {
          return;
        }
        const id = row.dataset.occurrenceId!;
        if (this.collapsedGroups.has(id)) {
          this.collapsedGroups.delete(id);
        } else {
          this.collapsedGroups.add(id);
        }
        this.renderRows();
      });
      row.addEventListener('contextmenu', (e) => {
        if ((e.target as HTMLElement).closest('[data-rename-input]')) {
          return;
        }
        e.preventDefault();
        const panelRect = this.panel.getBoundingClientRect();
        this.showOccurrenceDropdown(row.dataset.occurrenceId!, {
          top: e.clientY - panelRect.top,
          left: e.clientX - panelRect.left,
        });
      });
    });

    this.partsBody.querySelectorAll<HTMLElement>('[data-group-eye]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const members = this.membersOf(btn.dataset.groupEye!);
        if (members.length === 0) return;
        const show = members.every(m => !m.visible);
        for (const m of members) {
          if (m.visible !== show) {
            m.visible = show;
            this.onToggleVisibility(m.instanceId, show);
          }
        }
        this.renderRows();
      });
    });

    this.partsBody.querySelectorAll<HTMLElement>('[data-group-dots]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const rect = btn.getBoundingClientRect();
        const panelRect = this.panel.getBoundingClientRect();
        this.showOccurrenceDropdown(btn.dataset.groupDots!, {
          top: rect.bottom - panelRect.top + 2,
          left: rect.left - panelRect.left - 140,
        }, btn);
      });
    });
  }

  private bindRenameInput(): void {
    if (!this.inlineRename) {
      return;
    }
    const input = this.partsBody.querySelector<HTMLInputElement>('[data-rename-input]');
    if (!input) {
      return;
    }
    input.focus();
    input.select();
    const commit = () => {
      const target = this.inlineRename;
      this.inlineRename = null;
      const value = input.value.trim();
      if (!target || value.length === 0) {
        this.renderRows();
        return;
      }
      if (target.kind === 'occurrence') {
        this.occurrenceHandlers?.onRename(target.id, value);
      } else {
        this.onRename(target.id, value);
      }
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.inlineRename = null;
        this.renderRows();
      }
    });
    input.addEventListener('blur', commit);
    input.addEventListener('click', (e) => e.stopPropagation());
  }

  /**
   * The row menu, opened either under the ⋮ button (`anchor` given) or at the
   * pointer on a row right-click. `position` is relative to the panel, which
   * hosts the menu so it survives a row re-render.
   *
   * Occurrence-owned instances only offer Show in source: their statements
   * live in the SUB-ASSEMBLY's file, where a ground/rename/delete would edit
   * every occurrence — those actions belong to the group header instead.
   */
  private showDropdown(
    instanceId: string,
    position: { top: number; left: number },
    anchor?: HTMLElement,
  ): void {
    this.closeDropdown();
    if (this.readOnly) {
      return;
    }
    const inst = this.instances.find(i => i.instanceId === instanceId);
    if (!inst) {
      return;
    }
    const owned = (inst.owner ?? '') !== '';
    // Presence of resolved values ⇔ the definition declared param()s —
    // parameterless parts keep the item visible but disabled (discoverability
    // over hiding).
    const hasParams = !!inst.paramValues && Object.keys(inst.paramValues).length > 0;

    const dropdown = this.openDropdownShell(position, anchor);
    dropdown.innerHTML = `
      <ul class="menu menu-xs p-1 min-w-[160px]">
        ${PartsPanel.menuItem('show-in-source', ICON_CODE, 'Show in source')}
        ${owned ? '' : `
        ${PartsPanel.menuItem('edit-params', ICON_ADJUSTMENTS, 'Edit parameters…', '', !hasParams, 'This part has no parameters')}
        ${PartsPanel.menuItem('set-ground', ICON_GROUND, 'Toggle grounded', inst.grounded ? 'text-warning' : '')}
        ${PartsPanel.menuItem('rename', ICON_PENCIL, 'Rename')}
        ${PartsPanel.menuItem('delete', ICON_TRASH, 'Delete', 'text-error')}`}
      </ul>
    `;

    dropdown.querySelector('[data-action="show-in-source"]')!.addEventListener('click', () => {
      this.closeDropdown();
      this.onShowInSource(instanceId);
    });
    if (!owned && hasParams) {
      dropdown.querySelector('[data-action="edit-params"]')!.addEventListener('click', () => {
        this.closeDropdown();
        this.onEditParams?.('instance', instanceId);
      });
    }
    if (!owned) {
      dropdown.querySelector('[data-action="set-ground"]')!.addEventListener('click', () => {
        this.closeDropdown();
        // Toggle: a grounded instance drops its `.grounded()` again, rather than
        // re-writing the one it already has.
        this.onSetGround(instanceId, !inst.grounded);
      });
      dropdown.querySelector('[data-action="rename"]')!.addEventListener('click', () => {
        this.closeDropdown();
        this.inlineRename = { kind: 'instance', id: instanceId };
        this.renderRows();
      });
      dropdown.querySelector('[data-action="delete"]')!.addEventListener('click', () => {
        this.closeDropdown();
        this.onDeleteInstance(instanceId);
      });
    }
  }

  /** The group-header menu — actions target the occurrence's own insert() chain. */
  private showOccurrenceDropdown(
    occurrenceId: string,
    position: { top: number; left: number },
    anchor?: HTMLElement,
  ): void {
    this.closeDropdown();
    const occ = this.occurrences.find(o => o.occurrenceId === occurrenceId);
    const handlers = this.occurrenceHandlers;
    if (!occ || !handlers || this.readOnly) {
      return;
    }

    const hasParams = (occ.params?.length ?? 0) > 0;
    const dropdown = this.openDropdownShell(position, anchor);
    dropdown.innerHTML = `
      <ul class="menu menu-xs p-1 min-w-[160px]">
        ${PartsPanel.menuItem('show-in-source', ICON_CODE, 'Show in source')}
        ${PartsPanel.menuItem('edit-params', ICON_ADJUSTMENTS, 'Edit parameters…', '', !hasParams, 'This assembly has no parameters')}
        ${PartsPanel.menuItem('set-ground', ICON_GROUND, 'Toggle grounded', occ.grounded ? 'text-warning' : '')}
        ${PartsPanel.menuItem('rename', ICON_PENCIL, 'Rename')}
        ${PartsPanel.menuItem('delete', ICON_TRASH, 'Delete', 'text-error')}
      </ul>
    `;
    if (hasParams) {
      dropdown.querySelector('[data-action="edit-params"]')!.addEventListener('click', () => {
        this.closeDropdown();
        this.onEditParams?.('occurrence', occurrenceId);
      });
    }

    dropdown.querySelector('[data-action="show-in-source"]')!.addEventListener('click', () => {
      this.closeDropdown();
      handlers.onShowInSource(occurrenceId);
    });
    dropdown.querySelector('[data-action="set-ground"]')!.addEventListener('click', () => {
      this.closeDropdown();
      handlers.onSetGround(occurrenceId, !occ.grounded);
    });
    dropdown.querySelector('[data-action="rename"]')!.addEventListener('click', () => {
      this.closeDropdown();
      this.inlineRename = { kind: 'occurrence', id: occurrenceId };
      this.renderRows();
    });
    dropdown.querySelector('[data-action="delete"]')!.addEventListener('click', () => {
      this.closeDropdown();
      handlers.onDelete(occurrenceId);
    });
  }

  private openDropdownShell(
    position: { top: number; left: number },
    anchor?: HTMLElement,
  ): HTMLDivElement {
    const dropdown = document.createElement('div');
    dropdown.className = 'absolute z-[200] panel-bg border border-base-content/10 rounded-md shadow-[0_4px_12px_rgba(0,0,0,0.4)]';
    dropdown.style.top = `${position.top}px`;
    dropdown.style.left = `${position.left}px`;
    this.panel.appendChild(dropdown);
    this.activeDropdown = dropdown;

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
    return dropdown;
  }

  /** One icon + label menu row, matching the timeline panel's context menu. */
  private static menuItem(
    action: string,
    icon: string,
    label: string,
    extraClass = '',
    disabled = false,
    disabledTip = '',
  ): string {
    // Disabled items stay VISIBLE (a grayed row with a tooltip beats a
    // mysteriously missing one) but never bind a handler.
    const li = disabled ? ' class="menu-disabled"' : '';
    const attrs = disabled ? ` disabled title="${disabledTip}"` : '';
    return `<li${li}><button data-action="${action}"${attrs} class="flex items-center gap-2 ${extraClass}">`
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
