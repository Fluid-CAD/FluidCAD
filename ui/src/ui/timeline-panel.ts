import type { SceneObjectRender } from '../types';
import { savePreference, recompute, rollback, addBreakpoint, gotoSource } from '../api';
import { ICON_CIRCLE_CHECK, ICON_REFRESH, ICON_CHEVRON_RIGHT, ICON_CUBE, ICON_DOTS_VERTICAL, ICON_CHECK, ICON_ALERT_DOT } from './icons';
import { resolveIconName, ICON_IMG_FALLBACK } from './object-icons';
import { ShapesPanel } from './shapes-panel';

const SECTION_HEADER = 'flex items-center gap-2 px-3 py-2 panel-bg border border-base-content/10 rounded-md cursor-pointer select-none shrink-0';

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

export class TimelinePanel {
  private panel: HTMLDivElement;
  private fileLabel: HTMLSpanElement;
  private timelineBody: HTMLDivElement;
  private contentWrapper: HTMLDivElement;
  private positioner: HTMLDivElement;
  private shapesPanel: ShapesPanel;
  private loaded = false;
  private sceneObjects: SceneObjectRender[] = [];
  private rollbackStop = -1;
  private collapsedIds = new Set<string>();
  private timelineExpanded = true;
  private activeDropdown: HTMLDivElement | null = null;
  private dropdownCleanup: (() => void) | null = null;
  private showBuildTimings = false;
  private historyTotalLabel!: HTMLSpanElement;
  private hoverPopover: HTMLDivElement | null = null;
  private onImportFile: () => void;

  constructor(
    container: HTMLElement,
    onHighlightShape: (shapeId: string) => void,
    onExportShapes: (shapeIds: string[]) => void,
    onToggleShapeVisibility: (shapeId: string, visible: boolean) => void,
    isShapeHidden: (shapeId: string) => boolean,
    onSetShapeTransparency: (shapeId: string, opacity: number) => void,
    getShapeTransparency: (shapeId: string) => number,
    onResetAllTransparency: () => void,
    onImportFile: () => void,
  ) {
    this.onImportFile = onImportFile;
    this.panel = document.createElement('div');
    this.panel.className = 'absolute left-6 top-6 bottom-6 w-[220px] z-[99] flex flex-col gap-1 select-none hidden';
    container.appendChild(this.panel);
    this.applyPanelWidth();

    const logoRow = document.createElement('div');
    logoRow.className = 'flex items-center gap-1.5 px-1 pb-1 shrink-0';
    logoRow.innerHTML = `<img src="/logo.png" alt="FluidCAD" class="h-6 w-auto opacity-70" /><span class="text-[18px] font-bold text-base-content/70">FluidCAD</span>`;
    this.panel.appendChild(logoRow);

    const fileRow = document.createElement('div');
    fileRow.className = 'flex items-center gap-2 px-1 pb-1 shrink-0';
    fileRow.innerHTML = `
      <span class="text-base-content/50 [&>svg]:size-4">${ICON_CUBE}</span>
      <span data-ref="filename" class="text-base text-base-content/70 truncate"></span>
      <button data-ref="import-btn" class="ml-auto w-5 h-5 min-h-0 btn btn-circle btn-ghost border border-base-content/30 hover:border-base-content/50 p-0 text-base-content/40 hover:text-base-content/70 shrink-0 tooltip tooltip-right" data-tip="Import File">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      </button>
    `;
    this.panel.appendChild(fileRow);
    this.fileLabel = fileRow.querySelector('[data-ref="filename"]')!;
    fileRow.querySelector('[data-ref="import-btn"]')!.addEventListener('click', () => this.onImportFile());

    this.positioner = document.createElement('div');
    this.positioner.className = 'relative flex-1 min-h-0 overflow-hidden';
    this.panel.appendChild(this.positioner);

    this.contentWrapper = document.createElement('div');
    this.contentWrapper.className = 'absolute inset-0 flex flex-col gap-1 overflow-y-auto';
    this.contentWrapper.style.transition = 'transform 0.25s ease, opacity 0.25s ease';
    this.positioner.appendChild(this.contentWrapper);

    // Timeline accordion section
    const timelineHeader = document.createElement('div');
    timelineHeader.className = SECTION_HEADER;
    timelineHeader.innerHTML = `
      <span data-ref="chevron" class="flex items-center justify-center w-5 h-5 opacity-50 transition-transform rotate-90">${ICON_CHEVRON_RIGHT}</span>
      <span class="text-sm font-medium text-base-content/70">History</span>
      <span data-ref="history-total" class="text-xs text-base-content/40 tabular-nums hidden"></span>
      <button data-ref="history-dots" class="ml-auto btn btn-ghost btn-square btn-xs text-base-content/40 hover:text-base-content/70 shrink-0">${ICON_DOTS_VERTICAL}</button>
    `;
    this.contentWrapper.appendChild(timelineHeader);
    this.historyTotalLabel = timelineHeader.querySelector<HTMLSpanElement>('[data-ref="history-total"]')!;
    const historyDotsBtn = timelineHeader.querySelector<HTMLButtonElement>('[data-ref="history-dots"]')!;
    historyDotsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.showHistoryDropdown(historyDotsBtn);
    });

    this.timelineBody = document.createElement('div');
    this.timelineBody.className = 'py-1 overflow-y-auto min-h-0';
    this.contentWrapper.appendChild(this.timelineBody);

    timelineHeader.addEventListener('click', () => {
      this.timelineExpanded = !this.timelineExpanded;
      this.timelineBody.classList.toggle('hidden', !this.timelineExpanded);
      const chevron = timelineHeader.querySelector('[data-ref="chevron"]')!;
      chevron.classList.toggle('rotate-90', this.timelineExpanded);
    });

    // Shapes accordion section (delegated to ShapesPanel)
    this.shapesPanel = new ShapesPanel(
      this.panel,
      onHighlightShape,
      onExportShapes,
      onToggleShapeVisibility,
      isShapeHidden,
      onSetShapeTransparency,
      getShapeTransparency,
      onResetAllTransparency,
    );
    this.contentWrapper.appendChild(this.shapesPanel.header);
    this.contentWrapper.appendChild(this.shapesPanel.body);

  }

  update(sceneObjects: SceneObjectRender[], rollbackStop: number, absPath?: string): void {
    this.sceneObjects = sceneObjects;
    this.rollbackStop = rollbackStop;
    if (absPath) {
      const fileName = absPath.split('/').pop() || absPath;
      this.fileLabel.textContent = fileName;
    }
    if (!this.loaded) {
      this.loaded = true;
      this.panel.classList.remove('hidden');
    }
    this.renderTimeline(true);
    this.shapesPanel.update(sceneObjects);
    this.updateHistoryTotal();
  }

  setShowBuildTimings(value: boolean): void {
    if (this.showBuildTimings === value) {
      return;
    }
    this.showBuildTimings = value;
    this.applyPanelWidth();
    this.updateHistoryTotal();
    if (this.loaded) {
      this.renderTimeline();
    }
  }

  slideOut(): void {
    this.contentWrapper.style.transform = 'translateX(-100%)';
    this.contentWrapper.style.opacity = '0';
    this.contentWrapper.style.pointerEvents = 'none';
  }

  slideIn(): void {
    this.contentWrapper.style.transform = '';
    this.contentWrapper.style.opacity = '';
    this.contentWrapper.style.pointerEvents = '';
  }

  get toolbarHost(): HTMLElement {
    return this.positioner;
  }

  // ---------------------------------------------------------------------------
  // Timeline rendering
  // ---------------------------------------------------------------------------

  private renderTimeline(scrollToCurrent = false): void {
    const items = this.sceneObjects;
    const rollbackStop = this.rollbackStop;

    const parentIds = new Set<string>();
    const childErrorByParent = new Map<string, boolean>();
    for (const obj of items) {
      if (obj.uniqueType === 'lazy-select') {
        continue;
      }
      if (obj.parentId) {
        parentIds.add(obj.parentId);
        if (obj.hasError) {
          childErrorByParent.set(obj.parentId, true);
        }
      }
    }

    let html = '';

    for (let i = 0; i < items.length; i++) {
      const obj = items[i];
      if (obj.parentId) {
        continue;
      }
      if (obj.uniqueType === 'lazy-select') {
        continue;
      }

      const hasChildren = obj.id != null && parentIds.has(obj.id);
      const isCollapsed = obj.id != null && this.collapsedIds.has(obj.id);
      const childHasError = obj.id != null && childErrorByParent.get(obj.id) === true;
      const effectiveError = obj.hasError === true || childHasError;

      html += this.renderTimelineItem(obj, i, rollbackStop, false, hasChildren, isCollapsed, effectiveError);

      if (hasChildren && !isCollapsed) {
        for (let j = 0; j < items.length; j++) {
          if (items[j].uniqueType === 'lazy-select') {
            continue;
          }
          if (items[j].parentId === obj.id) {
            html += this.renderTimelineItem(items[j], j, rollbackStop, true, false, false, items[j].hasError === true);
          }
        }
      }
    }

    this.timelineBody.innerHTML = html;

    this.timelineBody.querySelectorAll<HTMLElement>('[data-index]').forEach((el) => {
      el.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('[data-toggle]')) {
          return;
        }
        const index = parseInt(el.dataset.index!, 10);
        this.rollbackTo(index);
        this.goToSource(this.sceneObjects[index]);
      });
      el.addEventListener('dblclick', (e) => {
        if ((e.target as HTMLElement).closest('[data-toggle]')) {
          return;
        }
        const index = parseInt(el.dataset.index!, 10);
        this.addBreakpointAfter(index);
        this.goToSource(this.sceneObjects[index]);
      });
    });

    this.timelineBody.querySelectorAll<HTMLElement>('[data-toggle]').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = el.dataset.toggle!;
        if (this.collapsedIds.has(id)) {
          this.collapsedIds.delete(id);
        } else {
          this.collapsedIds.add(id);
        }
        this.renderTimeline();
      });
    });

    if (this.showBuildTimings) {
      this.timelineBody.querySelectorAll<HTMLElement>('[data-index]').forEach((el) => {
        const index = parseInt(el.dataset.index!, 10);
        const obj = this.sceneObjects[index];
        if (!obj || !obj.profileCategories || obj.profileCategories.length === 0) {
          return;
        }
        el.addEventListener('mouseenter', () => {
          this.showProfilePopover(el, obj.profileCategories!, obj.buildDurationMs);
        });
        el.addEventListener('mouseleave', () => {
          this.closeProfilePopover();
        });
      });
    }

    if (scrollToCurrent) {
      const currentEl = this.timelineBody.querySelector<HTMLElement>('[data-current="true"]');
      if (currentEl) {
        currentEl.scrollIntoView({ block: 'nearest' });
      }
    }
  }

  private renderTimelineItem(obj: SceneObjectRender, index: number, rollbackStop: number, isChild: boolean, hasChildren: boolean, isCollapsed: boolean, effectiveError: boolean): string {
    const isCurrent = index === rollbackStop;
    const isPast = index > rollbackStop;
    const isInvisible = obj.visible === false;
    const name = obj.name || 'Unknown';
    const iconSrc = obj.type === 'part' ? '/icons/box.png' : `/icons/${resolveIconName(obj.uniqueType, obj.type)}.png`;

    let itemClass = 'flex items-center gap-1 px-3 py-1.5 cursor-pointer hover:bg-base-content/[0.06] text-sm';

    if (isChild) {
      itemClass += ' pl-7';
    }

    if (isCurrent) {
      itemClass += ' border-l-2 border-primary bg-primary/10';
    }
    if (effectiveError) {
      itemClass += ' text-error';
    } else if (isCurrent) {
      itemClass += ' text-primary';
    } else if (isPast || isInvisible) {
      itemClass += ' text-base-content/60';
    } else {
      itemClass += ' text-base-content/80';
    }

    const imgClass = isInvisible ? 'w-4 h-4 object-contain grayscale opacity-60' : 'w-4 h-4 object-contain';
    const errorDot = effectiveError
      ? `<span class="text-error shrink-0 [&>svg]:w-2.5 [&>svg]:h-2.5">${ICON_ALERT_DOT}</span>`
      : '';

    let chevron = '';
    if (hasChildren) {
      const rotation = isCollapsed ? '' : 'rotate-90';
      chevron = `<span data-toggle="${obj.id}" class="flex items-center justify-center w-5 h-5 opacity-50 hover:opacity-100 transition-transform ${rotation}">
        ${ICON_CHEVRON_RIGHT}
      </span>`;
    } else {
      chevron = '<span class="w-4"></span>';
    }

    const showDuration = this.showBuildTimings && !obj.fromCache && obj.buildDurationMs != null;
    const durationSpan = showDuration
      ? `<span class="ml-auto shrink-0 text-xs text-base-content/40 tabular-nums">${formatDuration(obj.buildDurationMs!)}</span>`
      : '';

    const statusIconClass = showDuration
      ? 'shrink-0 text-base-content/40 [&>svg]:w-4 [&>svg]:h-4'
      : 'ml-auto shrink-0 text-base-content/40 [&>svg]:w-4 [&>svg]:h-4';
    const statusIcon = obj.fromCache
      ? `<span class="${statusIconClass}">${ICON_CIRCLE_CHECK}</span>`
      : `<span class="${statusIconClass}">${ICON_REFRESH}</span>`;

    return `
      <div class="${itemClass}" data-index="${index}" data-container="${obj.isContainer ?? false}" data-current="${isCurrent}">
        ${chevron}
        ${errorDot}
        <img src="${iconSrc}" ${ICON_IMG_FALLBACK} class="${imgClass}" alt="" />
        <span class="truncate">${name}</span>
        ${durationSpan}
        ${statusIcon}
      </div>
    `;
  }

  // ---------------------------------------------------------------------------
  // Build timings
  // ---------------------------------------------------------------------------

  private hasBuildTimings(): boolean {
    return this.sceneObjects.some(
      (o) => !o.parentId && !o.fromCache && o.buildDurationMs != null,
    );
  }

  private updateHistoryTotal(): void {
    if (!this.showBuildTimings) {
      this.historyTotalLabel.classList.add('hidden');
      return;
    }
    let total = 0;
    let hasAny = false;
    for (const obj of this.sceneObjects) {
      if (obj.parentId) {
        continue;
      }
      if (obj.fromCache || obj.buildDurationMs == null) {
        continue;
      }
      total += obj.buildDurationMs;
      hasAny = true;
    }
    if (!hasAny) {
      this.historyTotalLabel.classList.add('hidden');
      return;
    }
    this.historyTotalLabel.textContent = `· ${formatDuration(total)}`;
    this.historyTotalLabel.classList.remove('hidden');
  }

  private applyPanelWidth(): void {
    this.panel.classList.toggle('w-[220px]', !this.showBuildTimings);
    this.panel.classList.toggle('w-[270px]', this.showBuildTimings);
  }

  // ---------------------------------------------------------------------------
  // History dropdown
  // ---------------------------------------------------------------------------

  private showHistoryDropdown(anchor: HTMLElement): void {
    this.closeDropdown();

    const dropdown = document.createElement('div');
    dropdown.className = 'absolute z-[200] panel-bg border border-base-content/10 rounded-md shadow-[0_4px_12px_rgba(0,0,0,0.4)]';

    const rect = anchor.getBoundingClientRect();
    const panelRect = this.panel.getBoundingClientRect();
    dropdown.style.top = `${rect.bottom - panelRect.top + 2}px`;
    dropdown.style.right = `${panelRect.right - rect.right}px`;

    const checkIcon = this.showBuildTimings
      ? `<span class="flex items-center justify-center w-4 h-4 shrink-0 text-primary [&>svg]:size-3">${ICON_CHECK}</span>`
      : `<span class="w-4 h-4 shrink-0"></span>`;

    dropdown.innerHTML = `
      <ul class="menu menu-xs p-1 min-w-[180px]">
        <li><button data-action="recompute" class="flex items-center gap-2">
          <span class="flex items-center justify-center w-4 h-4 shrink-0 [&>svg]:size-3.5">${ICON_REFRESH}</span>
          <span>Recompute scene</span>
        </button></li>
        <li><button data-action="toggle-timings" class="flex items-center gap-2">
          ${checkIcon}
          <span>Show execution time</span>
        </button></li>
      </ul>
    `;

    this.panel.appendChild(dropdown);
    this.activeDropdown = dropdown;

    dropdown.querySelector('[data-action="toggle-timings"]')!.addEventListener('click', () => {
      const next = !this.showBuildTimings;
      this.showBuildTimings = next;
      this.applyPanelWidth();
      this.updateHistoryTotal();
      savePreference('showBuildTimings', next);
      this.closeDropdown();
      this.renderTimeline();
      // Build timings are only recorded for objects that actually rebuild, so
      // enabling the toggle on a fully-cached scene would show nothing. Force a
      // fresh recompute so the times populate immediately.
      if (next && !this.hasBuildTimings()) {
        this.recomputeScene();
      }
    });

    dropdown.querySelector('[data-action="recompute"]')!.addEventListener('click', () => {
      this.closeDropdown();
      this.recomputeScene();
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

  // ---------------------------------------------------------------------------
  // Profile popover
  // ---------------------------------------------------------------------------

  private showProfilePopover(
    anchor: HTMLElement,
    categories: { category: string; durationMs: number }[],
    totalBuildMs?: number,
  ): void {
    this.closeProfilePopover();

    const popover = document.createElement('div');
    popover.className = 'absolute z-[201] panel-bg border border-base-content/10 rounded-md shadow-[0_4px_12px_rgba(0,0,0,0.4)] p-3 min-w-[200px] max-w-[280px]';

    const rect = anchor.getBoundingClientRect();
    const panelRect = this.panel.getBoundingClientRect();
    popover.style.left = `${rect.right - panelRect.left + 8}px`;
    popover.style.top = `${Math.max(0, rect.top - panelRect.top - 4)}px`;

    const profiledTotal = categories.reduce((sum, c) => sum + c.durationMs, 0);
    const displayRows: { category: string; durationMs: number; isOther?: boolean }[] = categories.map(c => ({ ...c }));
    if (totalBuildMs !== undefined && totalBuildMs - profiledTotal > 0.5) {
      displayRows.push({
        category: 'Other',
        durationMs: Math.round((totalBuildMs - profiledTotal) * 10) / 10,
        isOther: true,
      });
    }
    const maxDuration = Math.max(...displayRows.map(c => c.durationMs), 0.1);

    let rowsHtml = '';
    for (const cat of displayRows) {
      const pct = maxDuration > 0 ? (cat.durationMs / maxDuration) * 100 : 0;
      const barColor = cat.isOther
        ? 'bg-base-content/25'
        : pct > 60 ? 'bg-warning/60' : 'bg-primary/40';
      rowsHtml += `
        <div class="mb-1.5">
          <div class="flex justify-between text-xs mb-0.5">
            <span class="text-base-content/80 truncate mr-2">${this.escapeHtml(cat.category)}</span>
            <span class="text-base-content/50 tabular-nums shrink-0">${formatDuration(cat.durationMs)}</span>
          </div>
          <div class="h-1 rounded-full bg-base-content/10 overflow-hidden">
            <div class="h-full rounded-full ${barColor}" style="width:${pct}%"></div>
          </div>
        </div>
      `;
    }

    const footerHtml = totalBuildMs !== undefined
      ? `<div class="flex justify-between text-xs text-base-content/40 mt-1 pt-1 border-t border-base-content/10">
           <span>Total</span>
           <span class="tabular-nums">${formatDuration(totalBuildMs)}</span>
         </div>`
      : '';

    popover.innerHTML = `
      <div class="text-xs font-medium text-base-content/60 mb-2">Build Time Breakdown</div>
      ${rowsHtml}
      ${footerHtml}
    `;

    this.panel.appendChild(popover);
    this.hoverPopover = popover;
  }

  private closeProfilePopover(): void {
    if (this.hoverPopover) {
      this.hoverPopover.remove();
      this.hoverPopover = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  private recomputeScene(): void {
    recompute();
  }

  private rollbackTo(index: number): void {
    rollback(index);
  }

  private addBreakpointAfter(index: number): void {
    const obj = this.sceneObjects[index];
    if (!obj || !obj.sourceLocation) {
      return;
    }
    addBreakpoint(obj.sourceLocation);
  }

  private goToSource(obj: SceneObjectRender | undefined): void {
    if (!obj || !obj.sourceLocation) {
      return;
    }
    gotoSource(obj.sourceLocation);
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

}
