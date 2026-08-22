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
import { ICON_IMG_FALLBACK } from './object-icons';

const SECTION_HEADER = 'flex items-center gap-2 px-3 py-2 panel-bg border border-base-content/10 rounded-md cursor-pointer select-none shrink-0';
const CHEVRON_SVG = '<svg width="14" height="14" viewBox="0 0 10 10" fill="currentColor"><path d="M3 1l5 4-5 4z"/></svg>';
const DOTS_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>';

const STATUS_COLORS: Record<SerializedAssemblyMate['status'], string> = {
  satisfied: 'bg-success',
  redundant: 'bg-warning',
  inconsistent: 'bg-error',
};

export interface JointsPanelOptions {
  /** A host that cannot edit source: rows select/highlight only, no ⋮ or context menu. */
  readOnly?: boolean;
  /**
   * Offer "Animate" on slider/revolute rows (opens the animate bar). A
   * non-mutating action, so owned (sub-assembly) mates get it too.
   */
  onAnimate?: (mateId: string) => void;
}

export class JointsPanel {
  private header: HTMLDivElement;
  private body: HTMLDivElement;
  private mates: SerializedAssemblyMate[] = [];
  private instancesById = new Map<string, RenderedInstance>();
  private expanded = true;
  private activeDropdown: HTMLDivElement | null = null;
  private dropdownCleanup: (() => void) | null = null;
  private selectedId: string | null = null;

  private onSelectMate: (mateId: string) => void;
  private onShowInSource: (mateId: string) => void;
  private onEditMate: (mateId: string) => void;
  private onSuppress: (mateId: string) => void;
  private onDelete: (mateId: string) => void;
  private readonly readOnly: boolean;
  private readonly onAnimate: ((mateId: string) => void) | undefined;

  constructor(
    host: HTMLElement,
    onSelectMate: (mateId: string) => void,
    onShowInSource: (mateId: string) => void,
    onEditMate: (mateId: string) => void,
    onSuppress: (mateId: string) => void,
    onDelete: (mateId: string) => void,
    options: JointsPanelOptions = {},
  ) {
    this.readOnly = options.readOnly === true;
    this.onAnimate = options.onAnimate;
    this.onSelectMate = onSelectMate;
    this.onShowInSource = onShowInSource;
    this.onEditMate = onEditMate;
    this.onSuppress = onSuppress;
    this.onDelete = onDelete;

    // Row menus are absolutely positioned from coordinates measured against
    // the host's rect — the host must BE the positioning context, or they
    // resolve against some higher positioned ancestor and land offset by
    // whatever sits above this section (the parts panel, in the left rail).
    host.classList.add('relative');

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

  setSelected(mateId: string | null): void {
    if (this.selectedId === mateId) {
      return;
    }
    this.selectedId = mateId;
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
      // Tangent mates carry geometry sides instead of connector sides.
      const aId = mate.connectorA?.instanceId ?? mate.geometryA?.instanceId;
      const bId = mate.connectorB?.instanceId ?? mate.geometryB?.instanceId;
      const aName = (aId !== undefined ? this.instancesById.get(aId)?.name : undefined) ?? '?';
      const bName = (bId !== undefined ? this.instancesById.get(bId)?.name : undefined) ?? '?';
      const dotColor = STATUS_COLORS[mate.status];
      const selected = this.selectedId === mate.mateId;
      const selectedClass = selected ? ' bg-primary/10' : '';
      const limits = mate.options?.limits;
      const limitsLine = limits
        ? `<span class="pl-11 text-[10px] text-base-content/40">${limits[0]} – ${limits[1]}${mate.type === 'revolute' ? '°' : ' mm'}</span>`
        : '';
      html += `
        <div class="group flex items-start gap-2 px-3 py-1.5 cursor-pointer hover:bg-base-content/[0.06] text-base-content/80${selectedClass}" data-mate-id="${mate.mateId}">
          <div class="flex-1 min-w-0 flex flex-col leading-tight">
            <span class="flex items-center gap-2 text-sm">
              <span class="shrink-0 inline-block w-2 h-2 rounded-full ${dotColor}"></span>
              <img src="/icons/joint-${mate.type}.png" ${ICON_IMG_FALLBACK} class="shrink-0 w-5 h-5 object-contain" alt="" />
              ${escapeHtml(mate.type)}
            </span>
            <span class="pl-11 text-[10px] text-base-content/50 truncate">${escapeHtml(aName)}</span>
            <span class="pl-11 text-[10px] text-base-content/50 truncate">${escapeHtml(bName)}</span>
            ${limitsLine}
          </div>
          ${this.readOnly ? '' : `<button class="opacity-0 group-hover:opacity-100 btn btn-ghost btn-square btn-xs text-base-content/40 hover:text-base-content/70 shrink-0" data-dots="${mate.mateId}">${DOTS_SVG}</button>`}
        </div>
      `;
    }
    this.body.innerHTML = html;

    this.body.querySelectorAll<HTMLElement>('[data-mate-id]').forEach((row) => {
      row.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        if (target.closest('[data-dots]')) return;
        const id = row.dataset.mateId!;
        this.selectedId = id;
        this.renderRows();
        this.onSelectMate(id);
      });
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const hostRect = this.host().getBoundingClientRect();
        this.showDropdown(row.dataset.mateId!, {
          top: e.clientY - hostRect.top,
          left: e.clientX - hostRect.left,
        });
      });
    });

    this.body.querySelectorAll<HTMLElement>('[data-dots]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const rect = btn.getBoundingClientRect();
        const hostRect = this.host().getBoundingClientRect();
        this.showDropdown(btn.dataset.dots!, {
          top: rect.bottom - hostRect.top + 2,
          left: rect.left - hostRect.left - 140,
        }, btn);
      });
    });
  }

  /** The panel element dropdowns are positioned in (the section's host). */
  private host(): HTMLElement {
    return this.body.parentElement as HTMLElement;
  }

  private showDropdown(
    mateId: string,
    position: { top: number; left: number },
    anchor?: HTMLElement,
  ): void {
    this.closeDropdown();
    if (this.readOnly) {
      return;
    }

    const dropdown = document.createElement('div');
    dropdown.className = 'absolute z-[200] panel-bg border border-base-content/10 rounded-md shadow-[0_4px_12px_rgba(0,0,0,0.4)]';
    dropdown.style.top = `${position.top}px`;
    dropdown.style.left = `${position.left}px`;

    // Owned mates' statements live in the sub-assembly's file — offer only
    // the non-mutating action, same as the parts panel's owned rows.
    const mate = this.mates.find(m => m.mateId === mateId);
    const owned = (mate?.owner ?? '') !== '';
    const animatable = this.onAnimate !== undefined
      && (mate?.type === 'revolute' || mate?.type === 'slider');
    dropdown.innerHTML = `
      <ul class="menu menu-xs p-1 min-w-[160px]">
        <li><button data-action="show-in-source">Show in source</button></li>
        ${animatable ? '<li><button data-action="animate">Animate…</button></li>' : ''}
        ${owned ? '' : `
        <li><button data-action="edit-mate">Edit mate…</button></li>
        <li><button data-action="suppress">Suppress</button></li>
        <li><button data-action="delete" class="text-error">Delete</button></li>`}
      </ul>
    `;

    this.host().appendChild(dropdown);
    this.activeDropdown = dropdown;

    dropdown.querySelector('[data-action="show-in-source"]')!.addEventListener('click', () => {
      this.closeDropdown();
      this.onShowInSource(mateId);
    });
    if (animatable) {
      dropdown.querySelector('[data-action="animate"]')!.addEventListener('click', () => {
        this.closeDropdown();
        this.onAnimate!(mateId);
      });
    }
    if (!owned) {
      dropdown.querySelector('[data-action="edit-mate"]')!.addEventListener('click', () => {
        this.closeDropdown();
        this.onEditMate(mateId);
      });
      dropdown.querySelector('[data-action="suppress"]')!.addEventListener('click', () => {
        this.closeDropdown();
        this.onSuppress(mateId);
      });
      dropdown.querySelector('[data-action="delete"]')!.addEventListener('click', () => {
        this.closeDropdown();
        this.onDelete(mateId);
      });
    }

    const onClickOutside = (e: MouseEvent) => {
      if (!dropdown.contains(e.target as Node) && !anchor?.contains(e.target as Node)) {
        this.closeDropdown();
      }
    };
    // A right-click elsewhere dismisses too — a row's own contextmenu handler
    // runs first (and re-opens the menu there), so a fresh menu survives it.
    setTimeout(() => {
      document.addEventListener('click', onClickOutside);
      document.addEventListener('contextmenu', onClickOutside);
    }, 0);
    this.dropdownCleanup = () => {
      document.removeEventListener('click', onClickOutside);
      document.removeEventListener('contextmenu', onClickOutside);
    };
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
