import type { SceneObjectRender } from '../types';
import { savePreference } from '../preferences';
import { ICON_CIRCLE_CHECK, ICON_REFRESH, ICON_EYE, ICON_EYE_OFF } from './icons';
import { resolveIconName } from './object-icons';

console.log('[timeline] bundle loaded: breakpoint-debug-v1');

const SECTION_HEADER = 'flex items-center gap-2 px-3 py-2 panel-bg border border-base-content/10 rounded-md cursor-pointer select-none shrink-0';
const CHEVRON_SVG = '<svg width="14" height="14" viewBox="0 0 10 10" fill="currentColor"><path d="M3 1l5 4-5 4z"/></svg>';
const CUBE_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>';
const DOTS_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>';
const CHECK_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

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
  private shapesBody: HTMLDivElement;
  private loaded = false;
  private sceneObjects: SceneObjectRender[] = [];
  private pendingClickTimer: number | undefined;
  private rollbackStop = -1;
  private collapsedIds = new Set<string>();
  private collapsedShapeGroups = new Set<string>();
  private selectedShapeIds = new Set<string>();
  private timelineExpanded = true;
  private shapesExpanded = true;
  private onHighlightShape: (shapeId: string) => void;
  private onExportShapes: (shapeIds: string[]) => void;
  private onToggleShapeVisibility: (shapeId: string, visible: boolean) => void;
  private isShapeHidden: (shapeId: string) => boolean;
  private onSetShapeTransparency: (shapeId: string, opacity: number) => void;
  private getShapeTransparency: (shapeId: string) => number;
  private activeDropdown: HTMLDivElement | null = null;
  private dropdownCleanup: (() => void) | null = null;
  private activeTransparencyPopover: HTMLDivElement | null = null;
  private showBuildTimings = false;
  private historyTotalLabel!: HTMLSpanElement;

  constructor(
    container: HTMLElement,
    onHighlightShape: (shapeId: string) => void,
    onExportShapes: (shapeIds: string[]) => void,
    onToggleShapeVisibility: (shapeId: string, visible: boolean) => void,
    isShapeHidden: (shapeId: string) => boolean,
    onSetShapeTransparency: (shapeId: string, opacity: number) => void,
    getShapeTransparency: (shapeId: string) => number,
  ) {
    this.onHighlightShape = onHighlightShape;
    this.onExportShapes = onExportShapes;
    this.onToggleShapeVisibility = onToggleShapeVisibility;
    this.isShapeHidden = isShapeHidden;
    this.onSetShapeTransparency = onSetShapeTransparency;
    this.getShapeTransparency = getShapeTransparency;

    // Panel — hidden until first scene load
    this.panel = document.createElement('div');
    this.panel.className = 'absolute left-6 top-6 bottom-6 w-[220px] z-[99] flex flex-col gap-1 select-none hidden';
    container.appendChild(this.panel);
    this.applyPanelWidth();

    // Logo above file name
    const logoRow = document.createElement('div');
    logoRow.className = 'flex items-center gap-1.5 px-1 pb-1 shrink-0';
    logoRow.innerHTML = `<img src="/logo.png" alt="FluidCAD" class="h-6 w-auto opacity-70" /><span class="text-[18px] font-bold text-base-content/70">FluidCAD</span>`;
    this.panel.appendChild(logoRow);

    // File name label above accordion
    const fileRow = document.createElement('div');
    fileRow.className = 'flex items-center gap-2 px-1 pb-1 shrink-0';
    fileRow.innerHTML = `
      <span class="text-base-content/50 [&>svg]:size-4">${CUBE_SVG}</span>
      <span data-ref="filename" class="text-base text-base-content/70 truncate"></span>
    `;
    this.panel.appendChild(fileRow);
    this.fileLabel = fileRow.querySelector('[data-ref="filename"]')!;

    // Timeline accordion section
    const timelineHeader = document.createElement('div');
    timelineHeader.className = SECTION_HEADER;
    timelineHeader.innerHTML = `
      <span data-ref="chevron" class="flex items-center justify-center w-5 h-5 opacity-50 transition-transform rotate-90">${CHEVRON_SVG}</span>
      <span class="text-sm font-medium text-base-content/70">History</span>
      <span data-ref="history-total" class="text-xs text-base-content/40 tabular-nums hidden"></span>
      <button data-ref="history-dots" class="ml-auto btn btn-ghost btn-square btn-xs text-base-content/40 hover:text-base-content/70 shrink-0">${DOTS_SVG}</button>
    `;
    this.panel.appendChild(timelineHeader);
    this.historyTotalLabel = timelineHeader.querySelector<HTMLSpanElement>('[data-ref="history-total"]')!;
    const historyDotsBtn = timelineHeader.querySelector<HTMLButtonElement>('[data-ref="history-dots"]')!;
    historyDotsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.showHistoryDropdown(historyDotsBtn);
    });

    this.timelineBody = document.createElement('div');
    this.timelineBody.className = 'py-1 overflow-y-auto min-h-0 flex-[2]';
    this.panel.appendChild(this.timelineBody);

    // Shapes accordion section
    const shapesHeader = document.createElement('div');
    shapesHeader.className = SECTION_HEADER;
    shapesHeader.innerHTML = `
      <span class="flex items-center justify-center w-5 h-5 opacity-50 transition-transform rotate-90">${CHEVRON_SVG}</span>
      <span class="text-sm font-medium text-base-content/70">Shapes</span>
    `;
    this.panel.appendChild(shapesHeader);

    this.shapesBody = document.createElement('div');
    this.shapesBody.className = 'py-1 overflow-y-auto min-h-[120px] flex-1';
    this.panel.appendChild(this.shapesBody);

    // Bind accordion header toggles
    timelineHeader.addEventListener('click', () => {
      this.timelineExpanded = !this.timelineExpanded;
      this.timelineBody.classList.toggle('hidden', !this.timelineExpanded);
      const chevron = timelineHeader.querySelector('[data-ref="chevron"]')!;
      chevron.classList.toggle('rotate-90', this.timelineExpanded);
    });

    shapesHeader.addEventListener('click', () => {
      this.shapesExpanded = !this.shapesExpanded;
      this.shapesBody.classList.toggle('hidden', !this.shapesExpanded);
      const chevron = shapesHeader.querySelector('span')!;
      chevron.classList.toggle('rotate-90', this.shapesExpanded);
    });
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
    this.renderShapes();
    this.updateHistoryTotal();
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

  // ---------------------------------------------------------------------------
  // Timeline section
  // ---------------------------------------------------------------------------

  private renderTimeline(scrollToCurrent = false): void {
    const items = this.sceneObjects;
    const rollbackStop = this.rollbackStop;

    const parentIds = new Set<string>();
    for (const obj of items) {
      if (obj.parentId) {
        parentIds.add(obj.parentId);
      }
    }

    let html = '';

    for (let i = 0; i < items.length; i++) {
      const obj = items[i];
      if (obj.parentId) {
        continue;
      }

      const hasChildren = obj.id != null && parentIds.has(obj.id);
      const isCollapsed = obj.id != null && this.collapsedIds.has(obj.id);

      html += this.renderTimelineItem(obj, i, rollbackStop, false, hasChildren, isCollapsed);

      if (hasChildren && !isCollapsed) {
        for (let j = 0; j < items.length; j++) {
          if (items[j].parentId === obj.id) {
            html += this.renderTimelineItem(items[j], j, rollbackStop, true, false, false);
          }
        }
      }
    }

    this.timelineBody.innerHTML = html;

    // Bind rollback click handlers. We defer the rollback by one dblclick
    // window so that a double-click can cancel it in favour of adding a
    // breakpoint — rolling back on the first click would re-render this
    // timeline and break dblclick detection for the pair.
    this.timelineBody.querySelectorAll<HTMLElement>('[data-index]').forEach((el) => {
      el.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('[data-toggle]')) {
          return;
        }
        const index = parseInt(el.dataset.index!, 10);
        const obj = this.sceneObjects[index];
        console.log('[timeline] click', {
          index,
          name: obj?.name,
          sourceLocation: obj?.sourceLocation,
        });
        if (this.pendingClickTimer !== undefined) {
          window.clearTimeout(this.pendingClickTimer);
        }
        this.pendingClickTimer = window.setTimeout(() => {
          this.pendingClickTimer = undefined;
          this.rollbackTo(index);
        }, 250);
      });
      el.addEventListener('dblclick', (e) => {
        if ((e.target as HTMLElement).closest('[data-toggle]')) {
          return;
        }
        if (this.pendingClickTimer !== undefined) {
          window.clearTimeout(this.pendingClickTimer);
          this.pendingClickTimer = undefined;
        }
        const index = parseInt(el.dataset.index!, 10);
        const obj = this.sceneObjects[index];
        console.log('[timeline] dblclick', {
          index,
          name: obj?.name,
          sourceLocation: obj?.sourceLocation,
          targetEl: el.outerHTML.slice(0, 200),
        });
        this.addBreakpointAfter(index);
      });
    });

    // Bind expand/collapse toggle handlers
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

    if (scrollToCurrent) {
      const currentEl = this.timelineBody.querySelector<HTMLElement>('[data-current="true"]');
      if (currentEl) {
        currentEl.scrollIntoView({ block: 'nearest' });
      }
    }
  }

  private renderTimelineItem(obj: SceneObjectRender, index: number, rollbackStop: number, isChild: boolean, hasChildren: boolean, isCollapsed: boolean): string {
    const isCurrent = index === rollbackStop;
    const isPast = index > rollbackStop;
    const isInvisible = obj.visible === false;
    const hasError = obj.hasError === true;
    const name = obj.name
      ? obj.name.charAt(0).toUpperCase() + obj.name.slice(1)
      : obj.type || 'Unknown';
    const iconSrc = obj.type === 'part' ? '/icons/box.png' : `/icons/${resolveIconName(obj.uniqueType, obj.type)}.png`;

    let itemClass = 'flex items-center gap-1 px-3 py-1.5 cursor-pointer hover:bg-base-content/[0.06] text-sm';

    if (isChild) {
      itemClass += ' pl-7';
    }

    if (isCurrent) {
      itemClass += ' border-l-2 border-primary bg-primary/10 text-primary';
    } else if (hasError) {
      itemClass += ' text-error';
    } else if (isPast || isInvisible) {
      itemClass += ' text-base-content/60';
    } else {
      itemClass += ' text-base-content/80';
    }

    const imgClass = isInvisible ? 'w-4 h-4 object-contain grayscale opacity-60' : 'w-4 h-4 object-contain';

    let chevron = '';
    if (hasChildren) {
      const rotation = isCollapsed ? '' : 'rotate-90';
      chevron = `<span data-toggle="${obj.id}" class="flex items-center justify-center w-5 h-5 opacity-50 hover:opacity-100 transition-transform ${rotation}">
        ${CHEVRON_SVG}
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
        <img src="${iconSrc}" class="${imgClass}" alt="" />
        <span class="truncate">${name}</span>
        ${durationSpan}
        ${statusIcon}
      </div>
    `;
  }

  private async rollbackTo(index: number): Promise<void> {
    try {
      await fetch('/api/rollback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ index }),
      });
    } catch (err) {
      console.error('Rollback failed:', err);
    }
  }

  private async addBreakpointAfter(index: number): Promise<void> {
    const obj = this.sceneObjects[index];
    if (!obj || !obj.sourceLocation) {
      console.log('[timeline] addBreakpointAfter: skipping, no sourceLocation', { index, obj });
      return;
    }
    console.log('[timeline] addBreakpointAfter POST', {
      index,
      name: obj.name,
      sourceLocation: obj.sourceLocation,
    });
    try {
      await fetch('/api/add-breakpoint', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceLocation: obj.sourceLocation }),
      });
    } catch (err) {
      console.error('Add breakpoint failed:', err);
    }
  }

  // ---------------------------------------------------------------------------
  // Shapes section
  // ---------------------------------------------------------------------------

  private renderShapes(): void {
    const groups = new Map<string, { shapeId: string; shapeType: string }[]>();

    for (const obj of this.sceneObjects) {
      for (const shape of obj.sceneShapes) {
        if (shape.isMetaShape) {
          continue;
        }
        const type = shape.shapeType || 'unknown';
        if (!groups.has(type)) {
          groups.set(type, []);
        }
        groups.get(type)!.push({
          shapeId: shape.shapeId || '',
          shapeType: type,
        });
      }
    }

    let html = '';

    for (const [type, shapes] of groups) {
      const capitalized = type.charAt(0).toUpperCase() + type.slice(1);
      const isCollapsed = this.collapsedShapeGroups.has(type);
      const rotation = isCollapsed ? '' : 'rotate-90';

      html += `
        <div class="flex items-center gap-1 px-3 py-1.5 cursor-pointer hover:bg-base-content/[0.06] text-sm text-base-content/70 font-medium" data-shape-group="${type}">
          <span class="flex items-center justify-center w-5 h-5 opacity-50 hover:opacity-100 transition-transform ${rotation}">
            ${CHEVRON_SVG}
          </span>
          <span>${capitalized}</span>
          <span class="text-base-content/40 ml-1">${shapes.length}</span>
        </div>
      `;

      if (!isCollapsed) {
        for (let i = 0; i < shapes.length; i++) {
          const shape = shapes[i];
          const isSelected = this.selectedShapeIds.has(shape.shapeId);
          const selectedClass = isSelected ? ' bg-primary/10' : '';
          const hidden = this.isShapeHidden(shape.shapeId);
          const eyeIcon = hidden ? ICON_EYE_OFF : ICON_EYE;
          const eyeVisibility = hidden ? 'opacity-100 text-base-content/70' : 'opacity-0 group-hover:opacity-100 text-base-content/40';
          const eyeBtn = `<button class="ml-auto btn btn-ghost btn-square btn-xs ${eyeVisibility} hover:text-base-content/70 shrink-0 [&>svg]:size-3.5" data-eye="${shape.shapeId}">${eyeIcon}</button>`;
          const dotsBtn = `<button class="opacity-0 group-hover:opacity-100 btn btn-ghost btn-square btn-xs text-base-content/40 hover:text-base-content/70 shrink-0" data-dots="${shape.shapeId}">${DOTS_SVG}</button>`;
          html += `
            <div class="group flex items-center gap-2 pl-9 pr-3 py-1 cursor-pointer hover:bg-base-content/[0.06] text-sm text-base-content/70${selectedClass}" data-shape-id="${shape.shapeId}" data-shape-type="${shape.shapeType}">
              <img src="/icons/${shape.shapeType}.png" class="w-4 h-4 object-contain" alt="" />
              <span class="truncate">${capitalized} ${i + 1}</span>
              ${eyeBtn}
              ${dotsBtn}
            </div>
          `;
        }
      }
    }

    this.shapesBody.innerHTML = html;

    // Bind shape group toggle
    this.shapesBody.querySelectorAll<HTMLElement>('[data-shape-group]').forEach((el) => {
      el.addEventListener('click', () => {
        const type = el.dataset.shapeGroup!;
        if (this.collapsedShapeGroups.has(type)) {
          this.collapsedShapeGroups.delete(type);
        } else {
          this.collapsedShapeGroups.add(type);
        }
        this.renderShapes();
      });
    });

    // Bind shape item click to highlight + multi-select
    this.shapesBody.querySelectorAll<HTMLElement>('[data-shape-id]').forEach((el) => {
      el.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('[data-dots]')) {
          return;
        }
        if ((e.target as HTMLElement).closest('[data-eye]')) {
          return;
        }
        const shapeId = el.dataset.shapeId!;

        if (e.ctrlKey || e.metaKey) {
          if (this.selectedShapeIds.has(shapeId)) {
            this.selectedShapeIds.delete(shapeId);
          } else {
            this.selectedShapeIds.add(shapeId);
          }
        } else {
          this.selectedShapeIds.clear();
          this.selectedShapeIds.add(shapeId);
        }
        this.renderShapes();

        if (shapeId) {
          this.onHighlightShape(shapeId);
        }
      });
    });

    // Bind 3-dot menu buttons
    this.shapesBody.querySelectorAll<HTMLElement>('[data-dots]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const shapeId = btn.dataset.dots!;
        this.showShapeDropdown(btn, shapeId);
      });
    });

    // Bind eye visibility toggle buttons
    this.shapesBody.querySelectorAll<HTMLElement>('[data-eye]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const shapeId = btn.dataset.eye!;
        const nowVisible = this.isShapeHidden(shapeId);
        this.onToggleShapeVisibility(shapeId, nowVisible);
        this.renderShapes();
      });
    });
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

  private applyPanelWidth(): void {
    this.panel.classList.toggle('w-[220px]', !this.showBuildTimings);
    this.panel.classList.toggle('w-[270px]', this.showBuildTimings);
  }

  private showHistoryDropdown(anchor: HTMLElement): void {
    this.closeDropdown();

    const dropdown = document.createElement('div');
    dropdown.className = 'absolute z-[200] panel-bg border border-base-content/10 rounded-md shadow-[0_4px_12px_rgba(0,0,0,0.4)]';

    const rect = anchor.getBoundingClientRect();
    const panelRect = this.panel.getBoundingClientRect();
    dropdown.style.top = `${rect.bottom - panelRect.top + 2}px`;
    dropdown.style.right = `${panelRect.right - rect.right}px`;

    const checkMark = this.showBuildTimings
      ? `<span class="text-primary shrink-0">${CHECK_SVG}</span>`
      : `<span class="w-3 shrink-0"></span>`;

    dropdown.innerHTML = `
      <ul class="menu menu-xs p-1 min-w-[180px]">
        <li><button data-action="toggle-timings" class="flex items-center gap-2">
          ${checkMark}
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
    });

    const onClickOutside = (e: MouseEvent) => {
      if (!dropdown.contains(e.target as Node) && !anchor.contains(e.target as Node)) {
        this.closeDropdown();
      }
    };
    setTimeout(() => document.addEventListener('click', onClickOutside), 0);
    this.dropdownCleanup = () => document.removeEventListener('click', onClickOutside);
  }

  private showShapeDropdown(anchor: HTMLElement, shapeId: string): void {
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
      if (this.selectedShapeIds.has(shapeId) && this.selectedShapeIds.size > 0) {
        return [...this.selectedShapeIds];
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

  private showTransparencyPopover(anchor: HTMLElement, shapeIds: string[]): void {
    this.closeTransparencyPopover();

    const popover = document.createElement('div');
    popover.className = 'absolute z-[200] panel-bg border border-base-content/10 rounded-md shadow-[0_4px_12px_rgba(0,0,0,0.4)] p-3 w-[220px]';

    const rect = anchor.getBoundingClientRect();
    const panelRect = this.panel.getBoundingClientRect();
    popover.style.bottom = `${panelRect.bottom - rect.bottom}px`;
    popover.style.left = `${rect.left - panelRect.left}px`;

    const initialOpacity = this.getShapeTransparency(shapeIds[0]);
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
        this.onSetShapeTransparency(id, opacity);
      }
    });

    popover.querySelector('[data-action="close"]')!.addEventListener('click', () => {
      this.closeTransparencyPopover();
    });
  }

  private closeTransparencyPopover(): void {
    if (this.activeTransparencyPopover) {
      this.activeTransparencyPopover.remove();
      this.activeTransparencyPopover = null;
    }
  }
}
