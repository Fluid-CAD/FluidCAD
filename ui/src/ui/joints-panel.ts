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

import { type SerializedAssemblyMate, type SerializedAssemblyRelation, type RenderedInstance } from '../types';
import { MateLabel } from './mate-label';
import { sceneUnit } from '../units/scene-unit';
import { ICON_IMG_FALLBACK } from './object-icons';
import { ICON_PLAY } from './icons';
import { AccordionSection } from './accordion-section';
import { iconUrl } from './icon-url';

const DOTS_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>';

const STATUS_COLORS: Record<SerializedAssemblyMate['status'], string> = {
  satisfied: 'bg-success',
  redundant: 'bg-warning',
  inconsistent: 'bg-error',
};

export interface JointsPanelOptions {
  /**
   * A host that cannot edit source: rows select/highlight only, no ⋮ or
   * context menu. With `onAnimate` wired, slider/revolute rows still carry
   * a play button (and an Animate-only context menu): driving a mate never
   * touches the source.
   */
  readOnly?: boolean;
  /**
   * Offer "Animate" on slider/revolute rows (opens the animate bar). A
   * non-mutating action, so owned (sub-assembly) mates get it too.
   */
  onAnimate?: (mateId: string) => void;
  /** A relation row clicked: highlight the two joints it couples. */
  onSelectRelation?: (relationId: string) => void;
  /** A relation row's "Show in source". */
  onShowRelationInSource?: (relationId: string) => void;
  /** A relation row's "Edit relation…" — opens the relation dialog on it. */
  onEditRelation?: (relationId: string) => void;
  /** A relation row's "Delete" — drops the `relation()` statement. */
  onDeleteRelation?: (relationId: string) => void;
}

/** What a dialog picking a joint from this panel receives. */
export type JointPickHandler = (mate: SerializedAssemblyMate) => void;

export class JointsPanel {
  private header: HTMLDivElement;
  private body: HTMLDivElement;
  private mates: SerializedAssemblyMate[] = [];
  /** `relation()` rows, listed after the joints they couple. */
  private relations: SerializedAssemblyRelation[] = [];
  /** Relations the last solve could not hold (red dot). */
  private failedRelations = new Set<string>();
  /**
   * While a dialog picks a joint from the rail, a row click hands the mate
   * to it instead of selecting; relation rows sit inert. See {@link setPickMode}.
   */
  private pickHandler: JointPickHandler | null = null;
  private pickHint = '';
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
  private readonly relationActions: Pick<JointsPanelOptions, 'onSelectRelation' | 'onShowRelationInSource' | 'onEditRelation' | 'onDeleteRelation'>;

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
    this.relationActions = options;
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
    connectors: ReadonlyArray<{ connectorId: string; name: string; copy?: { slot: number } }> = [],
    relations: SerializedAssemblyRelation[] = [],
    failedRelations: ReadonlySet<string> = new Set(),
  ): void {
    // Labelled the way code names them — a copy as `bay.instance(2)`.
    this.worldConnectorNames = MateLabel.worldConnectorNames(connectors);
    this.mates = mates;
    this.relations = relations;
    this.failedRelations = new Set(failedRelations);
    this.instancesById.clear();
    for (const inst of instances) {
      this.instancesById.set(inst.instanceId, inst);
    }
    const countLabel = this.header.querySelector<HTMLSpanElement>('[data-ref="joints-count"]')!;
    const count = mates.length + relations.length;
    countLabel.textContent = count > 0 ? String(count) : '';
    this.renderRows();
  }

  /**
   * Route row clicks to a picking dialog (the relation dialog filling a
   * mate slot) instead of selecting, with `hint` shown above the rows;
   * `null` restores selection. The ⋮ menus stay reachable either way.
   */
  setPickMode(handler: JointPickHandler | null, hint = 'Click a joint to pick it'): void {
    if (this.pickHandler === handler && this.pickHint === hint) {
      return;
    }
    this.pickHandler = handler;
    this.pickHint = hint;
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
    if (this.mates.length === 0 && this.relations.length === 0) {
      this.body.innerHTML = AccordionSection.emptyState(
        'No joints yet — define mates with <code>mate(...)</code>.',
      );
      return;
    }

    const picking = this.pickHandler !== null;
    let html = picking
      ? `<div class="px-3 py-1.5 text-[11px] text-primary/80" data-pick-hint>${escapeHtml(this.pickHint)}</div>`
      : '';
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
      const pickClass = picking ? ' hover:bg-primary/10' : ' hover:bg-base-content/[0.06]';
      html += `
        <div class="group flex items-start gap-2 px-3 py-1.5 cursor-pointer${pickClass} text-base-content/80${selectedClass}" data-mate-id="${mate.mateId}">
          <div class="flex-1 min-w-0 flex flex-col leading-tight">
            <span class="flex items-center gap-2 text-sm">
              <span class="shrink-0 inline-block w-2 h-2 rounded-full ${dotColor}"></span>
              <img src="${iconUrl(`joint-${mate.type}`)}" ${ICON_IMG_FALLBACK} class="shrink-0 w-5 h-5 object-contain" alt="" />
              ${escapeHtml(mate.type)}
              ${mate.replica ? `<span class="text-[10px] text-base-content/40" data-replica-badge="${mate.mateId}" title="Replica — its statement is the replicate() call; edit the seed mate or the replicate statement">⧉</span>` : ''}
            </span>
            <span class="pl-11 text-[10px] text-base-content/50 truncate">${escapeHtml(aName)}</span>
            <span class="pl-11 text-[10px] text-base-content/50 truncate">${escapeHtml(bName)}</span>
            ${limitsLine}
            ${failureLine}
          </div>
          ${this.rowButton(mate)}
        </div>
      `;
    }
    for (const relation of this.relations) {
      html += this.relationRow(relation, picking);
    }
    this.body.innerHTML = html;

    this.body.querySelectorAll<HTMLElement>('[data-mate-id]').forEach((row) => {
      row.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        if (target.closest('[data-dots], [data-animate]')) return;
        const id = row.dataset.mateId!;
        // A picking dialog takes the joint; nothing gets selected.
        if (this.pickHandler) {
          const mate = this.mates.find(m => m.mateId === id);
          if (mate) {
            this.pickHandler(mate);
          }
          return;
        }
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
    this.body.querySelectorAll<HTMLElement>('[data-animate]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.closeDropdown();
        this.onAnimate!(btn.dataset.animate!);
      });
    });
    this.body.querySelectorAll<HTMLElement>('[data-relation-id]').forEach((row) => {
      row.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('[data-relation-dots]') || this.pickHandler) return;
        const id = row.dataset.relationId!;
        this.selectedId = id;
        this.renderRows();
        this.relationActions.onSelectRelation?.(id);
      });
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const hostRect = this.host().getBoundingClientRect();
        this.showRelationDropdown(row.dataset.relationId!, {
          top: e.clientY - hostRect.top,
          left: e.clientX - hostRect.left,
        });
      });
    });
    this.body.querySelectorAll<HTMLElement>('[data-relation-dots]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const rect = btn.getBoundingClientRect();
        const hostRect = this.host().getBoundingClientRect();
        this.showRelationDropdown(btn.dataset.relationDots!, {
          top: rect.bottom - hostRect.top + 2,
          left: rect.left - hostRect.left - 140,
        }, btn);
      });
    });
  }

  /**
   * A relation's row: the gear icon, `Gear × 2` / `Rack and pinion · 62.8
   * mm/rev` (+ `reverse`), the two coupled joints described under it, and a
   * dot that turns red when the last solve could not hold the coupling.
   * Inert (dimmed) while a dialog is picking joints.
   */
  private relationRow(relation: SerializedAssemblyRelation, picking: boolean): string {
    const names = new Map([...this.instancesById].map(([id, inst]) => [id, inst.name]));
    const describe = (mateId: string): string => {
      const mate = this.mates.find(m => m.mateId === mateId);
      return mate ? MateLabel.describe(mate, names, this.worldConnectorNames) : `? (${mateId})`;
    };
    const value = relation.type === 'gear'
      ? `× ${relation.ratio}`
      : `· ${relation.ratio} ${sceneUnit.current}/rev`;
    const label = `${relation.type === 'gear' ? 'Gear' : 'Rack and pinion'} ${value}${relation.reverse ? ' · reverse' : ''}`;
    const failed = this.failedRelations.has(relation.relationId);
    const dotColor = failed ? STATUS_COLORS.inconsistent : STATUS_COLORS.satisfied;
    const selectedClass = this.selectedId === relation.relationId ? ' bg-primary/10' : '';
    const stateClass = picking ? ' opacity-50' : ' cursor-pointer hover:bg-base-content/[0.06]';
    const dots = this.readOnly
      ? ''
      : `<button class="opacity-0 group-hover:opacity-100 btn btn-ghost btn-square btn-xs text-base-content/40 hover:text-base-content/70 shrink-0" data-relation-dots="${relation.relationId}">${DOTS_SVG}</button>`;
    return `
      <div class="group flex items-start gap-2 px-3 py-1.5 text-base-content/80${stateClass}${selectedClass}" data-relation-id="${relation.relationId}">
        <div class="flex-1 min-w-0 flex flex-col leading-tight">
          <span class="flex items-center gap-2 text-sm">
            <span class="shrink-0 inline-block w-2 h-2 rounded-full ${dotColor}"></span>
            <img src="${iconUrl('relation-gear')}" ${ICON_IMG_FALLBACK} class="shrink-0 w-5 h-5 object-contain" alt="" />
            ${escapeHtml(label)}
          </span>
          <span class="pl-11 text-[10px] text-base-content/50 truncate">${escapeHtml(describe(relation.mateA))}</span>
          <span class="pl-11 text-[10px] text-base-content/50 truncate">${escapeHtml(describe(relation.mateB))}</span>
          ${failed ? `<span class="pl-11 text-[10px] text-error/80">could not hold the ratio — a coupled joint is held</span>` : ''}
        </div>
        ${dots}
      </div>
    `;
  }

  /** The ⋮ menu of a relation row: Show in source, Edit relation…, Delete (owned rows: source only). */
  private showRelationDropdown(
    relationId: string,
    position: { top: number; left: number },
    anchor?: HTMLElement,
  ): void {
    this.closeDropdown();
    if (this.readOnly) {
      return;
    }
    const relation = this.relations.find(r => r.relationId === relationId);
    const owned = (relation?.owner ?? '') !== '';
    const dropdown = document.createElement('div');
    dropdown.className = 'absolute z-[200] panel-bg border border-base-content/10 rounded-md shadow-[0_4px_12px_rgba(0,0,0,0.4)]';
    dropdown.style.top = `${position.top}px`;
    dropdown.style.left = `${position.left}px`;
    dropdown.innerHTML = `
      <ul class="menu menu-xs p-1 min-w-[160px]">
        <li><button data-action="show-in-source">Show in source</button></li>
        ${owned ? '' : `
        <li><button data-action="edit-relation">Edit relation…</button></li>
        <li><button data-action="delete" class="text-error">Delete</button></li>`}
      </ul>
    `;
    this.host().appendChild(dropdown);
    this.activeDropdown = dropdown;
    dropdown.querySelector('[data-action="show-in-source"]')!.addEventListener('click', () => {
      this.closeDropdown();
      this.relationActions.onShowRelationInSource?.(relationId);
    });
    if (!owned) {
      dropdown.querySelector('[data-action="edit-relation"]')!.addEventListener('click', () => {
        this.closeDropdown();
        this.relationActions.onEditRelation?.(relationId);
      });
      dropdown.querySelector('[data-action="delete"]')!.addEventListener('click', () => {
        this.closeDropdown();
        this.relationActions.onDeleteRelation?.(relationId);
      });
    }
    this.watchOutsideClicks(dropdown, anchor);
  }

  /** Slider and revolute mates can be driven by the animate bar. */
  private isAnimatable(mate: SerializedAssemblyMate | undefined): boolean {
    return this.onAnimate !== undefined && (mate?.type === 'revolute' || mate?.type === 'slider');
  }

  /**
   * The row's trailing hover button: the ⋮ menu for an editing host; for
   * a read-only host, a play button on animatable rows (their only action)
   * and nothing otherwise.
   */
  private rowButton(mate: SerializedAssemblyMate): string {
    const base = 'opacity-0 group-hover:opacity-100 btn btn-ghost btn-square btn-xs text-base-content/40 hover:text-base-content/70 shrink-0';
    if (!this.readOnly) {
      return `<button class="${base}" data-dots="${mate.mateId}">${DOTS_SVG}</button>`;
    }
    if (this.isAnimatable(mate)) {
      return `<button class="${base} [&>svg]:size-4" data-animate="${mate.mateId}" title="Animate…">${ICON_PLAY}</button>`;
    }
    return '';
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
    // Owned mates' statements live in the sub-assembly's file, and a
    // replicated mate's statement is the replicate() call — offer only the
    // non-mutating actions, same as the parts panel's owned rows. A
    // read-only host has no source at all: Animate is its whole menu.
    const mate = this.mates.find(m => m.mateId === mateId);
    const owned = (mate?.owner ?? '') !== '' || mate?.replica !== undefined;
    const animatable = this.isAnimatable(mate);
    if (this.readOnly && !animatable) {
      return;
    }

    const dropdown = document.createElement('div');
    dropdown.className = 'absolute z-[200] panel-bg border border-base-content/10 rounded-md shadow-[0_4px_12px_rgba(0,0,0,0.4)]';
    dropdown.style.top = `${position.top}px`;
    dropdown.style.left = `${position.left}px`;

    dropdown.innerHTML = `
      <ul class="menu menu-xs p-1 min-w-[160px]">
        ${this.readOnly ? '' : '<li><button data-action="show-in-source">Show in source</button></li>'}
        ${animatable ? '<li><button data-action="animate">Animate…</button></li>' : ''}
        ${owned || this.readOnly ? '' : `
        <li><button data-action="edit-mate">Edit mate…</button></li>
        <li><button data-action="suppress">Suppress</button></li>
        <li><button data-action="delete" class="text-error">Delete</button></li>`}
      </ul>
    `;

    this.host().appendChild(dropdown);
    this.activeDropdown = dropdown;

    dropdown.querySelector('[data-action="show-in-source"]')?.addEventListener('click', () => {
      this.closeDropdown();
      this.onShowInSource(mateId);
    });
    if (animatable) {
      dropdown.querySelector('[data-action="animate"]')!.addEventListener('click', () => {
        this.closeDropdown();
        this.onAnimate!(mateId);
      });
    }
    if (!owned && !this.readOnly) {
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

    this.watchOutsideClicks(dropdown, anchor);
  }

  /** Dismiss the open menu on a click or right-click outside it (and its anchor button). */
  private watchOutsideClicks(dropdown: HTMLElement, anchor?: HTMLElement): void {
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
