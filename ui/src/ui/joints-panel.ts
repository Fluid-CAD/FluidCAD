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
import { AccordionSection } from './accordion-section';

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
  /** Assembly connectors by scene id — how a frame side labels itself. */
  private worldConnectorNames = new Map<string, string>();
  private activeDropdown: HTMLDivElement | null = null;
  private dropdownCleanup: (() => void) | null = null;
  private selectedId: string | null = null;
  /** Misclosure text per failing mate id (mate-failure-text.ts); patched in place per solve. */
  private failureDetails = new Map<string, string>();

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
    // The assembly rail's slots are `relative` by their own layout policy
    // (assembly-rail-split.ts, which rewrites their class lists); this
    // covers any other host.
    host.classList.add('relative');

    const section = new AccordionSection('Joints', {
      trailing: '<span data-ref="joints-count" class="text-xs text-base-content/40 tabular-nums"></span>',
    });
    this.header = section.header;
    this.body = section.body;
    this.renderRows();
    section.mount(host);
  }

  update(
    mates: SerializedAssemblyMate[],
    instances: RenderedInstance[],
    connectors: ReadonlyArray<{ connectorId: string; name: string }> = [],
  ): void {
    this.worldConnectorNames = new Map(connectors.map(c => [c.connectorId, c.name]));
    this.mates = mates;
    this.instancesById.clear();
    for (const inst of instances) {
      this.instancesById.set(inst.instanceId, inst);
    }
    const countLabel = this.header.querySelector<HTMLSpanElement>('[data-ref="joints-count"]')!;
    countLabel.textContent = mates.length > 0 ? String(mates.length) : '';
    this.renderRows();
  }

  /**
   * Refresh the misclosure line under each inconsistent row. Called per
   * solve (per pointermove during a drag), so it patches the existing text
   * nodes and only touches the DOM when a value actually changed —
   * `update()` is the only path that rebuilds the rows.
   */
  setFailureDetails(details: Map<string, string>): void {
    let changed = details.size !== this.failureDetails.size;
    if (!changed) {
      for (const [id, text] of details) {
        if (this.failureDetails.get(id) !== text) {
          changed = true;
          break;
        }
      }
    }
    if (!changed) {
      return;
    }
    this.failureDetails = new Map(details);
    this.body.querySelectorAll<HTMLElement>('[data-failure-detail]').forEach((el) => {
      el.textContent = this.failureDetails.get(el.dataset.failureDetail!) ?? '';
    });
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
      this.body.innerHTML = AccordionSection.emptyState(
        'No joints yet — define mates with <code>mate(...)</code>.',
      );
      return;
    }

    let html = '';
    for (const mate of this.mates) {
      // Tangent mates carry geometry sides instead of connector sides;
      // assembly-connector sides label with the connector's name.
      const sideName = (
        conn: { instanceId: string } | undefined,
        geo: { instanceId: string } | undefined,
        frame: { connectorId: string } | undefined,
      ): string => {
        if (frame) {
          return this.worldConnectorNames.get(frame.connectorId) ?? '?';
        }
        const id = conn?.instanceId ?? geo?.instanceId;
        return (id !== undefined ? this.instancesById.get(id)?.name : undefined) ?? '?';
      };
      const aName = sideName(mate.connectorA, mate.geometryA, mate.frameA);
      const bName = sideName(mate.connectorB, mate.geometryB, mate.frameB);
      const dotColor = STATUS_COLORS[mate.status];
      const selected = this.selectedId === mate.mateId;
      const selectedClass = selected ? ' bg-primary/10' : '';
      const limits = mate.options?.limits;
      const limitsLine = limits
        ? `<span class="pl-11 text-[10px] text-base-content/40">${limits[0]} – ${limits[1]}${mate.type === 'revolute' ? '°' : ' mm'}</span>`
        : '';
      // Inconsistent rows carry a misclosure line ("6.0 mm gap along Y");
      // the node exists whenever the row is inconsistent so per-solve
      // updates can patch its text without a re-render.
      const failureLine = mate.status === 'inconsistent'
        ? `<span class="pl-11 text-[10px] text-error/80" data-failure-detail="${mate.mateId}">${escapeHtml(this.failureDetails.get(mate.mateId) ?? '')}</span>`
        : '';
      html += `
        <div class="group flex items-start gap-2 px-3 py-1.5 cursor-pointer hover:bg-base-content/[0.06] text-base-content/80${selectedClass}" data-mate-id="${mate.mateId}">
          <div class="flex-1 min-w-0 flex flex-col leading-tight">
            <span class="flex items-center gap-2 text-sm">
              <span class="shrink-0 inline-block w-2 h-2 rounded-full ${dotColor}"></span>
              <img src="/icons/joint-${mate.type}.png" ${ICON_IMG_FALLBACK} class="shrink-0 w-5 h-5 object-contain" alt="" />
              ${escapeHtml(mate.type)}
              ${mate.replica ? `<span class="text-[10px] text-base-content/40" data-replica-badge="${mate.mateId}" title="Replica — its statement is the replicate() call; edit the seed mate or the replicate statement">⧉</span>` : ''}
            </span>
            <span class="pl-11 text-[10px] text-base-content/50 truncate">${escapeHtml(aName)}</span>
            <span class="pl-11 text-[10px] text-base-content/50 truncate">${escapeHtml(bName)}</span>
            ${limitsLine}
            ${failureLine}
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

    // Owned mates' statements live in the sub-assembly's file, and a
    // replicated mate's statement is the replicate() call — offer only the
    // non-mutating actions, same as the parts panel's owned rows.
    const mate = this.mates.find(m => m.mateId === mateId);
    const owned = (mate?.owner ?? '') !== '' || mate?.replica !== undefined;
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
