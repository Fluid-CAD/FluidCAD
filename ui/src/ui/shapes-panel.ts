import type { SceneObjectRender } from '../types';
import { ICON_EYE, ICON_EYE_OFF, ICON_CHEVRON_RIGHT, ICON_DOTS_VERTICAL } from './icons';
import { ICON_IMG_FALLBACK } from './object-icons';
import { AccordionSection } from './accordion-section';
import { iconUrl } from './icon-url';
import { findMatchingRow, rollbackScopeIds, sourceLocKey } from '../helpers/scene-utils';
import { ShapeLabels } from '../../../lib/rendering/shape-labels.js';

/** One listed shape: its action handle, its `<Type> <n>` label and the row that holds it. */
type ShapeRow = {
  shapeId: string;
  shapeType: string;
  label: string;
  holderName: string;
  /** The holder is past a rollback preview's stop: the shape is not on screen, and the row is inert. */
  past: boolean;
};

/** One collapsible group: a part row, or the fixed "Model" for part-less shapes. */
type ShapeGroup = {
  /** Survives renders: the part's source-location key, or {@link ShapesPanel.MODEL_GROUP_KEY}. */
  key: string;
  title: string;
  rows: ShapeRow[];
};

/**
 * The Shapes section of the docked column: every non-meta shape the render
 * produced, grouped by the part that holds it (part-less shapes under
 * "Model"), each row `<Type> <n>` — n counted per part and per shape type in
 * timeline order, the rule `ShapeLabels` owns and the scene summary shares —
 * over the feature that holds it ("from Extrude 2").
 *
 * The number is a label, never an identity: the eye and the row menu act on
 * `data-shape-id`, which the viewer translates per render (lineage keys keep
 * a hidden or faded body hidden or faded through later features and edits).
 * Collapsed groups are remembered by the part row's source location, so a
 * re-render keeps them folded.
 */
export class ShapesPanel extends AccordionSection {
  /** Group key of the shapes no part holds. */
  static readonly MODEL_GROUP_KEY = 'model';
  private static readonly MODEL_GROUP_TITLE = ShapeLabels.MODEL_LABEL;

  private panel: HTMLElement;
  /** The scene the rows are built from: the last complete render, even while a rollback previews part of it. */
  private sceneObjects: SceneObjectRender[] = [];
  /** The last complete (non-preview) render, or null before the first one. */
  private completeScene: SceneObjectRender[] | null = null;
  /** Ids of the holder rows a rollback preview cuts off: their shapes list dimmed. */
  private pastHolderIds = new Set<string>();
  private collapsedGroups = new Set<string>();
  private selectedIds = new Set<string>();
  private activeDropdown: HTMLDivElement | null = null;
  private dropdownCleanup: (() => void) | null = null;
  private activeTransparencyPopover: HTMLDivElement | null = null;

  private onHighlightShape: (shapeId: string) => void;
  private onExportShapes: (shapeIds: string[]) => void;
  private onToggleVisibility: (shapeId: string, visible: boolean) => void;
  private isShapeHidden: (shapeId: string) => boolean;
  private onSetTransparency: (shapeId: string, opacity: number) => void;
  private getTransparency: (shapeId: string) => number;
  private onResetAllTransparency: () => void;

  constructor(
    panel: HTMLElement,
    onHighlightShape: (shapeId: string) => void,
    onExportShapes: (shapeIds: string[]) => void,
    onToggleVisibility: (shapeId: string, visible: boolean) => void,
    isShapeHidden: (shapeId: string) => boolean,
    onSetTransparency: (shapeId: string, opacity: number) => void,
    getTransparency: (shapeId: string) => number,
    onResetAllTransparency: () => void,
  ) {
    // Nothing but the shared body: how this section and the History above it
    // split the column is BODY_CLASS's deal — see accordion-section.ts.
    super('Shapes');
    this.panel = panel;
    this.onHighlightShape = onHighlightShape;
    this.onExportShapes = onExportShapes;
    this.onToggleVisibility = onToggleVisibility;
    this.isShapeHidden = isShapeHidden;
    this.onSetTransparency = onSetTransparency;
    this.getTransparency = getTransparency;
    this.onResetAllTransparency = onResetAllTransparency;
  }

  /**
   * A complete render replaces the list. A rollback preview (`preview`: the
   * stop and the part it is scoped to) does not: the preview is a view of
   * the same model, so the list keeps the last complete render's rows and
   * only dims the ones the preview cuts off — the way History dims rows
   * past the stop. The row count never changes, so the section keeps its
   * height and the column's split stays put. Without a complete render to
   * hold on to (a refresh that replayed a rollback), the preview is listed
   * as it is.
   */
  update(sceneObjects: SceneObjectRender[], preview?: { stop: number; scopePartId: string | null }): void {
    if (!preview || this.completeScene === null) {
      this.sceneObjects = sceneObjects;
      this.pastHolderIds = new Set();
      if (!preview) {
        this.completeScene = sceneObjects;
      }
      this.render();
      return;
    }
    this.sceneObjects = this.completeScene;
    this.pastHolderIds = ShapesPanel.pastHolders(this.completeScene, sceneObjects, preview);
    this.render();
  }

  /**
   * The holders of `complete` whose row the preview places past its stop
   * (inside the scoped part when the stop is part-scoped), or drops: a
   * complete-render row is found in the preview by id, else by source
   * identity.
   */
  private static pastHolders(
    complete: SceneObjectRender[],
    preview: SceneObjectRender[],
    { stop, scopePartId }: { stop: number; scopePartId: string | null },
  ): Set<string> {
    const past = new Set<string>();
    const scoped = rollbackScopeIds(preview, scopePartId);
    const byId = new Map(preview.map((obj, index) => [obj.id, index]));
    for (const holder of complete) {
      if (holder.id == null || !(holder.sceneShapes ?? []).some((shape) => !shape.isMetaShape)) {
        continue;
      }
      const match = byId.has(holder.id) ? holder : findMatchingRow(holder, preview);
      const index = match?.id != null ? byId.get(match.id) : undefined;
      if (index === undefined || (index > stop && (scoped === null || scoped.has(match!.id!)))) {
        past.add(holder.id);
      }
    }
    return past;
  }

  /**
   * The groups in display order: "Model" first when it has shapes, then one
   * group per part in timeline order of the part rows. Labels and parts come
   * from `ShapeLabels` (holders in timeline order, shapes in their holder's
   * order), so a row reads exactly as the scene summary reports it.
   */
  private buildGroups(): ShapeGroup[] {
    const partGroups = new Map<string, ShapeGroup>();
    const model: ShapeGroup = { key: ShapesPanel.MODEL_GROUP_KEY, title: ShapesPanel.MODEL_GROUP_TITLE, rows: [] };

    for (const labelled of ShapeLabels.labelsFor(this.sceneObjects).values()) {
      const group = labelled.partRow ? ShapesPanel.groupFor(labelled.partRow, partGroups) : model;
      group.rows.push({
        shapeId: labelled.shapeId,
        shapeType: labelled.shapeType,
        label: labelled.label,
        holderName: labelled.holder.name ?? '',
        past: labelled.holder.id != null && this.pastHolderIds.has(labelled.holder.id),
      });
    }

    const groups = [...partGroups.values()];
    if (model.rows.length > 0) {
      groups.unshift(model);
    }
    return groups;
  }

  /** The group of a part row, created on first use (insertion order = timeline order). */
  private static groupFor(part: SceneObjectRender, groups: Map<string, ShapeGroup>): ShapeGroup {
    const key = ShapesPanel.partGroupKey(part);
    let group = groups.get(key);
    if (!group) {
      group = { key, title: part.name ?? 'Part', rows: [] };
      groups.set(key, group);
    }
    return group;
  }

  /**
   * A part row's identity across renders: its source location (plus the
   * occurrence for a part made in a loop); a row without one falls back to
   * its scene id, which lives one render.
   */
  private static partGroupKey(part: SceneObjectRender): string {
    const loc = part.sourceLocation;
    if (!loc) {
      return `id:${part.id ?? ''}`;
    }
    const base = sourceLocKey(loc);
    return loc.occurrence != null ? `${base}#${loc.occurrence}` : base;
  }

  private static escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  private render(): void {
    let html = '';

    for (const group of this.buildGroups()) {
      const isCollapsed = this.collapsedGroups.has(group.key);
      const rotation = isCollapsed ? '' : 'rotate-90';

      html += `
        <div class="flex items-center gap-1 px-3 py-1.5 cursor-pointer hover:bg-base-content/[0.06] text-sm text-base-content/70 font-medium" data-shape-group="${ShapesPanel.escapeHtml(group.key)}">
          <span class="flex items-center justify-center w-5 h-5 opacity-50 hover:opacity-100 transition-transform ${rotation}">
            ${ICON_CHEVRON_RIGHT}
          </span>
          <span class="truncate">${ShapesPanel.escapeHtml(group.title)}</span>
        </div>
      `;

      if (!isCollapsed) {
        for (const shape of group.rows) {
          // A row the preview cut off keeps its place but goes quiet: dimmed,
          // no hover, no eye or menu — its handle names a shape the preview
          // did not draw.
          if (shape.past) {
            html += `
            <div class="flex items-center gap-2 pl-9 pr-3 py-1 text-sm text-base-content/35 leading-tight" data-shape-id="${shape.shapeId}" data-shape-type="${shape.shapeType}" data-past="true" title="Not built at the previewed step">
              <img src="${iconUrl(shape.shapeType)}" ${ICON_IMG_FALLBACK} class="w-4 h-4 object-contain shrink-0 grayscale opacity-60" alt="" />
              <span class="min-w-0 flex-1">
                <span class="block truncate" data-shape-label>${ShapesPanel.escapeHtml(shape.label)}</span>
                <span class="block truncate text-xs text-base-content/30" data-shape-from>from ${ShapesPanel.escapeHtml(shape.holderName)}</span>
              </span>
            </div>
          `;
            continue;
          }
          const isSelected = this.selectedIds.has(shape.shapeId);
          const selectedClass = isSelected ? ' bg-primary/10' : '';
          const hidden = this.isShapeHidden(shape.shapeId);
          const eyeIcon = hidden ? ICON_EYE_OFF : ICON_EYE;
          const eyeVisibility = hidden ? 'opacity-100 text-base-content/70' : 'opacity-0 group-hover:opacity-100 text-base-content/40';
          const eyeBtn = `<button class="ml-auto btn btn-ghost btn-square btn-xs ${eyeVisibility} hover:text-base-content/70 shrink-0 [&>svg]:size-3.5" data-eye="${shape.shapeId}">${eyeIcon}</button>`;
          const dotsBtn = `<button class="opacity-0 group-hover:opacity-100 btn btn-ghost btn-square btn-xs text-base-content/40 hover:text-base-content/70 shrink-0" data-dots="${shape.shapeId}">${ICON_DOTS_VERTICAL}</button>`;
          html += `
            <div class="group flex items-center gap-2 pl-9 pr-3 py-1 cursor-pointer hover:bg-base-content/[0.06] text-sm text-base-content/70 leading-tight${selectedClass}" data-shape-id="${shape.shapeId}" data-shape-type="${shape.shapeType}">
              <img src="${iconUrl(shape.shapeType)}" ${ICON_IMG_FALLBACK} class="w-4 h-4 object-contain shrink-0" alt="" />
              <span class="min-w-0 flex-1">
                <span class="block truncate" data-shape-label>${ShapesPanel.escapeHtml(shape.label)}</span>
                <span class="block truncate text-xs text-base-content/50" data-shape-from>from ${ShapesPanel.escapeHtml(shape.holderName)}</span>
              </span>
              ${eyeBtn}
              ${dotsBtn}
            </div>
          `;
        }
      }
    }

    this.body.innerHTML = html
      || AccordionSection.emptyState('No shapes yet — they appear here as features build geometry.');

    this.body.querySelectorAll<HTMLElement>('[data-shape-group]').forEach((el) => {
      el.addEventListener('click', () => {
        const key = el.dataset.shapeGroup!;
        if (this.collapsedGroups.has(key)) {
          this.collapsedGroups.delete(key);
        } else {
          this.collapsedGroups.add(key);
        }
        this.render();
      });
    });

    this.body.querySelectorAll<HTMLElement>('[data-shape-id]:not([data-past])').forEach((el) => {
      el.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('[data-dots]')) {
          return;
        }
        if ((e.target as HTMLElement).closest('[data-eye]')) {
          return;
        }
        const shapeId = el.dataset.shapeId!;

        if (e.ctrlKey || e.metaKey) {
          if (this.selectedIds.has(shapeId)) {
            this.selectedIds.delete(shapeId);
          } else {
            this.selectedIds.add(shapeId);
          }
        } else {
          this.selectedIds.clear();
          this.selectedIds.add(shapeId);
        }
        this.render();

        if (shapeId) {
          this.onHighlightShape(shapeId);
        }
      });
    });

    this.body.querySelectorAll<HTMLElement>('[data-dots]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const shapeId = btn.dataset.dots!;
        this.showDropdown(btn, shapeId);
      });
    });

    this.body.querySelectorAll<HTMLElement>('[data-eye]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const shapeId = btn.dataset.eye!;
        const nowVisible = this.isShapeHidden(shapeId);
        this.onToggleVisibility(shapeId, nowVisible);
        this.render();
      });
    });
  }

  private showDropdown(anchor: HTMLElement, shapeId: string): void {
    this.closeDropdown();

    const dropdown = document.createElement('div');
    dropdown.className = 'absolute z-[200] panel-bg border border-base-content/10 rounded-md shadow-[0_4px_12px_rgba(0,0,0,0.4)]';

    const rect = anchor.getBoundingClientRect();
    const panelRect = this.panel.getBoundingClientRect();
    dropdown.style.top = `${rect.bottom - panelRect.top + 2}px`;
    dropdown.style.left = `${rect.left - panelRect.left}px`;

    dropdown.innerHTML = `
      <ul class="menu menu-xs p-1 min-w-[140px]">
        <li><button data-action="export">Export</button></li>
        <li><button data-action="set-transparency">Set Transparency</button></li>
      </ul>
    `;

    this.panel.appendChild(dropdown);
    this.activeDropdown = dropdown;

    const resolveIds = (): string[] => {
      if (this.selectedIds.has(shapeId) && this.selectedIds.size > 0) {
        return [...this.selectedIds];
      }
      return [shapeId];
    };

    dropdown.querySelector('[data-action="export"]')!.addEventListener('click', () => {
      const ids = resolveIds();
      this.closeDropdown();
      this.onExportShapes(ids);
    });

    dropdown.querySelector('[data-action="set-transparency"]')!.addEventListener('click', () => {
      const ids = resolveIds();
      this.closeDropdown();
      this.showTransparencyPopover(anchor, ids);
    });

    const onClickOutside = (e: MouseEvent) => {
      if (!dropdown.contains(e.target as Node) && !anchor.contains(e.target as Node)) {
        this.closeDropdown();
      }
    };
    setTimeout(() => document.addEventListener('click', onClickOutside), 0);
    this.dropdownCleanup = () => document.removeEventListener('click', onClickOutside);
  }

  private showTransparencyPopover(anchor: HTMLElement, shapeIds: string[]): void {
    this.closeTransparencyPopover();

    const popover = document.createElement('div');
    popover.className = 'absolute z-[200] panel-bg border border-base-content/10 rounded-md shadow-[0_4px_12px_rgba(0,0,0,0.4)] p-3 w-[220px]';

    const rect = anchor.getBoundingClientRect();
    const panelRect = this.panel.getBoundingClientRect();
    popover.style.bottom = `${panelRect.bottom - rect.bottom}px`;
    popover.style.left = `${rect.left - panelRect.left}px`;

    const initialOpacity = this.getTransparency(shapeIds[0]);
    const initialPct = Math.round(initialOpacity * 100);

    popover.innerHTML = `
      <div class="flex items-center justify-between mb-2">
        <span class="text-xs font-medium">Transparency</span>
        <button class="btn btn-ghost btn-xs btn-square" data-action="close">×</button>
      </div>
      <div class="flex items-center gap-2">
        <input type="range" min="0" max="100" value="${initialPct}" class="range range-xs flex-1" data-ref="slider" />
        <span class="text-xs text-base-content/60 w-10 text-right" data-ref="value">${initialPct}%</span>
      </div>
    `;

    this.panel.appendChild(popover);
    this.activeTransparencyPopover = popover;

    const slider = popover.querySelector('[data-ref="slider"]') as HTMLInputElement;
    const valueLabel = popover.querySelector('[data-ref="value"]') as HTMLElement;
    slider.addEventListener('input', () => {
      const pct = parseInt(slider.value, 10);
      const opacity = pct / 100;
      valueLabel.textContent = `${pct}%`;
      for (const id of shapeIds) {
        this.onSetTransparency(id, opacity);
      }
    });

    popover.querySelector('[data-action="close"]')!.addEventListener('click', () => {
      this.closeTransparencyPopover();
    });
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

  private closeTransparencyPopover(): void {
    if (this.activeTransparencyPopover) {
      this.activeTransparencyPopover.remove();
      this.activeTransparencyPopover = null;
      this.onResetAllTransparency();
    }
  }
}
