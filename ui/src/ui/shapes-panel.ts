import type { SceneObjectRender } from '../types';
import { ICON_EYE, ICON_EYE_OFF } from './icons';

const CHEVRON_SVG = '<svg width="14" height="14" viewBox="0 0 10 10" fill="currentColor"><path d="M3 1l5 4-5 4z"/></svg>';
const DOTS_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>';
const SECTION_HEADER = 'flex items-center gap-2 px-3 py-2 panel-bg border border-base-content/10 rounded-md cursor-pointer select-none shrink-0';

export class ShapesPanel {
  readonly header: HTMLDivElement;
  readonly body: HTMLDivElement;

  private panel: HTMLElement;
  private sceneObjects: SceneObjectRender[] = [];
  private collapsedGroups = new Set<string>();
  private selectedIds = new Set<string>();
  private expanded = true;
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
    this.panel = panel;
    this.onHighlightShape = onHighlightShape;
    this.onExportShapes = onExportShapes;
    this.onToggleVisibility = onToggleVisibility;
    this.isShapeHidden = isShapeHidden;
    this.onSetTransparency = onSetTransparency;
    this.getTransparency = getTransparency;
    this.onResetAllTransparency = onResetAllTransparency;

    this.header = document.createElement('div');
    this.header.className = SECTION_HEADER;
    this.header.innerHTML = `
      <span class="flex items-center justify-center w-5 h-5 opacity-50 transition-transform rotate-90">${CHEVRON_SVG}</span>
      <span class="text-sm font-medium text-base-content/70">Shapes</span>
    `;

    this.body = document.createElement('div');
    this.body.className = 'py-1 overflow-y-auto min-h-[33vh] flex-1';

    this.header.addEventListener('click', () => {
      this.expanded = !this.expanded;
      this.body.classList.toggle('hidden', !this.expanded);
      const chevron = this.header.querySelector('span')!;
      chevron.classList.toggle('rotate-90', this.expanded);
    });
  }

  update(sceneObjects: SceneObjectRender[]): void {
    this.sceneObjects = sceneObjects;
    this.render();
  }

  private render(): void {
    const groups = new Map<string, { shapeId: string; shapeType: string; sceneObjectName: string }[]>();

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
          sceneObjectName: obj.name,
        });
      }
    }

    let html = '';

    for (const [type, shapes] of groups) {
      const capitalized = type.charAt(0).toUpperCase() + type.slice(1);
      const isCollapsed = this.collapsedGroups.has(type);
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
        const nameTotals = new Map<string, number>();
        for (const shape of shapes) {
          nameTotals.set(shape.sceneObjectName, (nameTotals.get(shape.sceneObjectName) ?? 0) + 1);
        }
        const nameCounts = new Map<string, number>();
        for (let i = 0; i < shapes.length; i++) {
          const shape = shapes[i];
          const nameIndex = (nameCounts.get(shape.sceneObjectName) ?? 0) + 1;
          nameCounts.set(shape.sceneObjectName, nameIndex);
          const total = nameTotals.get(shape.sceneObjectName) ?? 1;
          const label = total > 1 ? `${shape.sceneObjectName} ${nameIndex}` : shape.sceneObjectName;
          const isSelected = this.selectedIds.has(shape.shapeId);
          const selectedClass = isSelected ? ' bg-primary/10' : '';
          const hidden = this.isShapeHidden(shape.shapeId);
          const eyeIcon = hidden ? ICON_EYE_OFF : ICON_EYE;
          const eyeVisibility = hidden ? 'opacity-100 text-base-content/70' : 'opacity-0 group-hover:opacity-100 text-base-content/40';
          const eyeBtn = `<button class="ml-auto btn btn-ghost btn-square btn-xs ${eyeVisibility} hover:text-base-content/70 shrink-0 [&>svg]:size-3.5" data-eye="${shape.shapeId}">${eyeIcon}</button>`;
          const dotsBtn = `<button class="opacity-0 group-hover:opacity-100 btn btn-ghost btn-square btn-xs text-base-content/40 hover:text-base-content/70 shrink-0" data-dots="${shape.shapeId}">${DOTS_SVG}</button>`;
          html += `
            <div class="group flex items-center gap-2 pl-9 pr-3 py-1 cursor-pointer hover:bg-base-content/[0.06] text-sm text-base-content/70${selectedClass}" data-shape-id="${shape.shapeId}" data-shape-type="${shape.shapeType}">
              <img src="/icons/${shape.shapeType}.png" class="w-4 h-4 object-contain" alt="" />
              <span class="truncate">${label}</span>
              ${eyeBtn}
              ${dotsBtn}
            </div>
          `;
        }
      }
    }

    this.body.innerHTML = html;

    this.body.querySelectorAll<HTMLElement>('[data-shape-group]').forEach((el) => {
      el.addEventListener('click', () => {
        const type = el.dataset.shapeGroup!;
        if (this.collapsedGroups.has(type)) {
          this.collapsedGroups.delete(type);
        } else {
          this.collapsedGroups.add(type);
        }
        this.render();
      });
    });

    this.body.querySelectorAll<HTMLElement>('[data-shape-id]').forEach((el) => {
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
