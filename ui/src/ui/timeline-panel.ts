import type { SceneObjectRender } from '../types';
import { ICON_CIRCLE_CHECK, ICON_REFRESH } from './icons';

const SECTION_HEADER = 'flex items-center gap-2 px-3 py-2 glass-dark border border-white/10 rounded-md cursor-pointer select-none shrink-0';
const CHEVRON_SVG = '<svg width="14" height="14" viewBox="0 0 10 10" fill="currentColor"><path d="M3 1l5 4-5 4z"/></svg>';
const CUBE_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>';
const DOTS_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>';

export class TimelinePanel {
  private panel: HTMLDivElement;
  private fileLabel: HTMLSpanElement;
  private timelineBody: HTMLDivElement;
  private shapesBody: HTMLDivElement;
  private loaded = false;
  private sceneObjects: SceneObjectRender[] = [];
  private rollbackStop = -1;
  private collapsedIds = new Set<string>();
  private collapsedShapeGroups = new Set<string>();
  private selectedShapeIds = new Set<string>();
  private timelineExpanded = true;
  private shapesExpanded = true;
  private onHighlightShape: (shapeId: string) => void;
  private onExportShapes: (shapeIds: string[]) => void;
  private activeDropdown: HTMLDivElement | null = null;
  private dropdownCleanup: (() => void) | null = null;

  constructor(container: HTMLElement, onHighlightShape: (shapeId: string) => void, onExportShapes: (shapeIds: string[]) => void) {
    this.onHighlightShape = onHighlightShape;
    this.onExportShapes = onExportShapes;

    // Panel — hidden until first scene load
    this.panel = document.createElement('div');
    this.panel.className = 'absolute left-6 top-6 bottom-6 w-[220px] z-[99] flex flex-col gap-1 select-none hidden';
    container.appendChild(this.panel);

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
      <span class="flex items-center justify-center w-5 h-5 opacity-50 transition-transform rotate-90">${CHEVRON_SVG}</span>
      <span class="text-sm font-medium text-base-content/70">History</span>
    `;
    this.panel.appendChild(timelineHeader);

    this.timelineBody = document.createElement('div');
    this.timelineBody.className = 'py-1 overflow-y-auto min-h-0';
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
    this.shapesBody.className = 'py-1 overflow-y-auto min-h-[120px]';
    this.panel.appendChild(this.shapesBody);

    // Bind accordion header toggles
    timelineHeader.addEventListener('click', () => {
      this.timelineExpanded = !this.timelineExpanded;
      this.timelineBody.classList.toggle('hidden', !this.timelineExpanded);
      const chevron = timelineHeader.querySelector('span')!;
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
    this.renderTimeline();
    this.renderShapes();
  }

  // ---------------------------------------------------------------------------
  // Timeline section
  // ---------------------------------------------------------------------------

  private renderTimeline(): void {
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

    // Bind rollback click handlers
    this.timelineBody.querySelectorAll<HTMLElement>('[data-index]').forEach((el) => {
      el.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('[data-toggle]')) {
          return;
        }
        const index = parseInt(el.dataset.index!, 10);
        const isContainer = el.dataset.container === 'true';
        this.rollbackTo(index, isContainer);
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

    const currentEl = this.timelineBody.querySelector<HTMLElement>('[data-current="true"]');
    if (currentEl) {
      currentEl.scrollIntoView({ block: 'nearest' });
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
    const iconSrc = obj.type === 'part' ? '/icons/box.png' : `/icons/${obj.type || 'solid'}.png`;

    let itemClass = 'flex items-center gap-1 px-3 py-1.5 cursor-pointer hover:bg-white/[0.06] text-sm';

    if (isChild) {
      itemClass += ' pl-7';
    }

    if (isCurrent) {
      itemClass += ' border-l-2 border-primary bg-primary/10 text-primary';
    } else if (hasError) {
      itemClass += ' text-error';
    } else if (isPast || isInvisible) {
      itemClass += ' opacity-60';
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

    const statusIcon = obj.fromCache
      ? `<span class="ml-auto shrink-0 opacity-40 [&>svg]:w-4 [&>svg]:h-4">${ICON_CIRCLE_CHECK}</span>`
      : `<span class="ml-auto shrink-0 opacity-40 [&>svg]:w-4 [&>svg]:h-4">${ICON_REFRESH}</span>`;

    return `
      <div class="${itemClass}" data-index="${index}" data-container="${obj.isContainer ?? false}" data-current="${isCurrent}">
        ${chevron}
        <img src="${iconSrc}" class="${imgClass}" alt="" />
        <span class="truncate">${name}</span>
        ${statusIcon}
      </div>
    `;
  }

  private async rollbackTo(index: number, isContainer: boolean): Promise<void> {
    const actualIndex = isContainer ? index + 1 : index;
    try {
      await fetch('/api/rollback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ index: actualIndex }),
      });
    } catch (err) {
      console.error('Rollback failed:', err);
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
        <div class="flex items-center gap-1 px-3 py-1.5 cursor-pointer hover:bg-white/[0.06] text-sm text-base-content/70 font-medium" data-shape-group="${type}">
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
          const dotsBtn = `<button class="ml-auto opacity-0 group-hover:opacity-100 btn btn-ghost btn-square btn-xs text-base-content/40 hover:text-base-content/70 shrink-0" data-dots="${shape.shapeId}">${DOTS_SVG}</button>`;
          html += `
            <div class="group flex items-center gap-2 pl-9 pr-3 py-1 cursor-pointer hover:bg-white/[0.06] text-sm text-base-content/70${selectedClass}" data-shape-id="${shape.shapeId}" data-shape-type="${shape.shapeType}">
              <img src="/icons/${shape.shapeType}.png" class="w-4 h-4 object-contain" alt="" />
              <span class="truncate">${capitalized} ${i + 1}</span>
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
  }

  private showShapeDropdown(anchor: HTMLElement, shapeId: string): void {
    this.closeDropdown();

    const dropdown = document.createElement('div');
    dropdown.className = 'absolute z-[200] glass-dark border border-white/10 rounded-md shadow-[0_4px_12px_rgba(0,0,0,0.4)]';

    const rect = anchor.getBoundingClientRect();
    const panelRect = this.panel.getBoundingClientRect();
    dropdown.style.top = `${rect.bottom - panelRect.top + 2}px`;
    dropdown.style.left = `${rect.left - panelRect.left}px`;

    dropdown.innerHTML = `
      <ul class="menu menu-xs p-1 min-w-[100px]">
        <li><button data-action="export">Export</button></li>
      </ul>
    `;

    this.panel.appendChild(dropdown);
    this.activeDropdown = dropdown;

    dropdown.querySelector('[data-action="export"]')!.addEventListener('click', () => {
      let ids: string[];
      if (this.selectedShapeIds.has(shapeId) && this.selectedShapeIds.size > 0) {
        ids = [...this.selectedShapeIds];
      } else {
        ids = [shapeId];
      }
      this.closeDropdown();
      this.onExportShapes(ids);
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
