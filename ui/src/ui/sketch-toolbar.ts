import { ICON_LINE, ICON_POLYLINE, ICON_CIRCLE, ICON_CENTER_ARC, ICON_THREE_POINT_ARC, ICON_TANGENT_ARC, ICON_RECT, ICON_ROUNDED_RECT, ICON_SCISSORS, ICON_CHEVRON_DOWN, ICON_SETTINGS } from './icons';
import { ToolId } from '../interactive/sketch-tool';

type ToolDef = { id: ToolId; label: string; icon: string };
type ToolGroup = { tools: ToolDef[] };
type ToolEntry = ToolDef | ToolGroup;

function isGroup(entry: ToolEntry): entry is ToolGroup {
  return 'tools' in entry;
}

const TOOL_LAYOUT: ToolEntry[] = [
  { tools: [
    { id: 'line', label: 'Line', icon: ICON_LINE },
    { id: 'polyline', label: 'Polyline', icon: ICON_POLYLINE },
  ]},
  { tools: [
    { id: 'circle', label: 'Circle', icon: ICON_CIRCLE },
  ]},
  { tools: [
    { id: 'rect', label: 'Rectangle', icon: ICON_RECT },
    { id: 'rounded-rect', label: 'Rounded Rectangle', icon: ICON_ROUNDED_RECT },
  ]},
  { tools: [
    { id: 'arc3', label: '3-Point Arc', icon: ICON_THREE_POINT_ARC },
    { id: 'arc2', label: 'Center Arc', icon: ICON_CENTER_ARC },
    { id: 'tarc', label: 'Tangent Arc', icon: ICON_TANGENT_ARC },
  ]},
  { tools: [
    { id: 'trim', label: 'Trim', icon: ICON_SCISSORS },
  ]},
];

const BTN_BASE = 'btn btn-ghost btn-square btn-sm text-base-content/60';
const BTN_ACTIVE = 'btn btn-soft btn-primary btn-square btn-sm';

export class SketchToolbar {
  private el: HTMLDivElement;
  private inner: HTMLDivElement;
  private snapMenu: HTMLDivElement | null = null;
  private onToolSelect: (toolId: ToolId | null) => void;
  private activeToolId: ToolId | null = null;
  private buttons = new Map<ToolId, HTMLButtonElement>();
  private expandedGroups = new Set<number>();
  private boundKeyDown: (e: KeyboardEvent) => void;
  private boundCloseSnapMenu: (e: MouseEvent) => void;
  private snapVertexCheckedState = true;
  private snapGridCheckedState = true;

  onSnapVerticesChange: ((checked: boolean) => void) | null = null;
  onSnapGridChange: ((checked: boolean) => void) | null = null;

  constructor(toolbarHost: HTMLElement, onToolSelect: (toolId: ToolId | null) => void) {
    this.onToolSelect = onToolSelect;

    this.el = document.createElement('div');
    this.el.className = 'absolute top-1/2 -translate-y-1/2 left-0 select-none pointer-events-auto flex flex-col items-center gap-1.5';
    this.el.style.transition = 'transform 0.25s ease, opacity 0.25s ease';
    this.el.style.transform = 'translateX(-100%)';
    this.el.style.opacity = '0';

    this.inner = document.createElement('div');
    this.inner.className = 'flex flex-col gap-0.5 panel-bg border border-base-content/10 rounded-md p-1';
    this.el.appendChild(this.inner);

    this.buildSnapButton();
    this.renderTools();

    toolbarHost.appendChild(this.el);

    this.boundKeyDown = this.handleKeyDown.bind(this);
    this.boundCloseSnapMenu = this.handleCloseSnapMenu.bind(this);
  }

  show(): void {
    this.el.style.transform = '';
    this.el.style.opacity = '';
    window.addEventListener('keydown', this.boundKeyDown);
  }

  hide(): void {
    this.el.style.transform = 'translateX(-100%)';
    this.el.style.opacity = '0';
    this.closeSnapMenu();
    window.removeEventListener('keydown', this.boundKeyDown);
    if (this.activeToolId) {
      this.setActiveTool(null);
    }
  }

  get isVisible(): boolean {
    return this.el.style.transform === '';
  }

  setActiveTool(toolId: ToolId | null): void {
    if (this.activeToolId === toolId) {
      return;
    }
    this.activeToolId = toolId;
    this.syncButtonStates();
  }

  get activeTool(): ToolId | null {
    return this.activeToolId;
  }

  get snapVerticesChecked(): boolean {
    return this.snapVertexCheckedState;
  }

  get snapGridChecked(): boolean {
    return this.snapGridCheckedState;
  }

  private buildSnapButton(): void {
    const cogWrapper = document.createElement('div');
    cogWrapper.className = 'relative';

    const cogBtn = document.createElement('button');
    cogBtn.className = BTN_BASE;
    cogBtn.innerHTML = `<span class="[&>svg]:size-5">${ICON_SETTINGS}</span>`;
    cogBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.snapMenu) {
        this.closeSnapMenu();
      } else {
        this.openSnapMenu(cogWrapper);
      }
    });
    cogWrapper.appendChild(cogBtn);

    this.el.appendChild(cogWrapper);
  }

  private openSnapMenu(anchor: HTMLElement): void {
    this.closeSnapMenu();

    const menu = document.createElement('div');
    menu.className = 'absolute left-full top-1/2 -translate-y-1/2 ml-2 z-[200] panel-bg border border-base-content/10 rounded-md shadow-[0_4px_12px_rgba(0,0,0,0.4)] p-2 flex flex-col gap-2 whitespace-nowrap';

    const vertexCheckbox = document.createElement('input');
    vertexCheckbox.type = 'checkbox';
    vertexCheckbox.className = 'checkbox checkbox-xs checkbox-primary';
    vertexCheckbox.checked = this.snapVertexCheckedState;
    vertexCheckbox.addEventListener('change', () => {
      this.snapVertexCheckedState = vertexCheckbox.checked;
      this.onSnapVerticesChange?.(vertexCheckbox.checked);
    });
    const vertexLabel = document.createElement('label');
    vertexLabel.className = 'flex items-center gap-2 cursor-pointer';
    vertexLabel.appendChild(vertexCheckbox);
    const vertexText = document.createElement('span');
    vertexText.className = 'text-xs text-base-content/70';
    vertexText.textContent = 'Snap to vertices';
    vertexLabel.appendChild(vertexText);

    const gridCheckbox = document.createElement('input');
    gridCheckbox.type = 'checkbox';
    gridCheckbox.className = 'checkbox checkbox-xs checkbox-primary';
    gridCheckbox.checked = this.snapGridCheckedState;
    gridCheckbox.addEventListener('change', () => {
      this.snapGridCheckedState = gridCheckbox.checked;
      this.onSnapGridChange?.(gridCheckbox.checked);
    });
    const gridLabel = document.createElement('label');
    gridLabel.className = 'flex items-center gap-2 cursor-pointer';
    gridLabel.appendChild(gridCheckbox);
    const gridText = document.createElement('span');
    gridText.className = 'text-xs text-base-content/70';
    gridText.textContent = 'Snap to grid';
    gridLabel.appendChild(gridText);

    menu.appendChild(vertexLabel);
    menu.appendChild(gridLabel);

    anchor.appendChild(menu);
    this.snapMenu = menu;

    setTimeout(() => document.addEventListener('click', this.boundCloseSnapMenu), 0);
  }

  private closeSnapMenu(): void {
    if (this.snapMenu) {
      this.snapMenu.remove();
      this.snapMenu = null;
      document.removeEventListener('click', this.boundCloseSnapMenu);
    }
  }

  private handleCloseSnapMenu(e: MouseEvent): void {
    if (this.snapMenu && !this.snapMenu.contains(e.target as Node) && !this.snapMenu.parentElement?.contains(e.target as Node)) {
      this.closeSnapMenu();
    }
  }

  private renderTools(): void {
    this.inner.innerHTML = '';
    this.buttons.clear();

    for (let i = 0; i < TOOL_LAYOUT.length; i++) {
      if (i > 0) {
        const sep = document.createElement('div');
        sep.className = 'h-px bg-base-content/[0.08] my-0.5';
        this.inner.appendChild(sep);
      }

      const entry = TOOL_LAYOUT[i];
      if (isGroup(entry)) {
        this.renderGroup(entry, i);
      } else {
        this.inner.appendChild(this.createToolButton(entry));
      }
    }
  }

  private renderGroup(group: ToolGroup, groupIndex: number): void {
    if (group.tools.length === 1) {
      this.inner.appendChild(this.createToolButton(group.tools[0]));
      return;
    }

    const expanded = this.expandedGroups.has(groupIndex);
    const visibleTool = this.getGroupVisibleTool(group);

    const wrapper = document.createElement('div');
    wrapper.className = 'flex flex-col gap-0.5 items-center';

    wrapper.appendChild(this.createToolButton(visibleTool));

    if (expanded) {
      for (const tool of group.tools) {
        if (tool.id === visibleTool.id) {
          continue;
        }
        wrapper.appendChild(this.createToolButton(tool));
      }
    }

    const chevron = document.createElement('span');
    chevron.className = `w-6 h-3 -mt-1 flex items-center justify-center text-base-content/40 hover:text-base-content/60 cursor-pointer transition-transform [&>svg]:size-4 ${expanded ? 'rotate-180' : ''}`;
    chevron.innerHTML = ICON_CHEVRON_DOWN;
    chevron.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.expandedGroups.has(groupIndex)) {
        this.expandedGroups.delete(groupIndex);
      } else {
        this.expandedGroups.add(groupIndex);
      }
      this.renderTools();
    });
    wrapper.appendChild(chevron);

    this.inner.appendChild(wrapper);
  }

  private getGroupVisibleTool(group: ToolGroup): ToolDef {
    if (this.activeToolId) {
      const activeTool = group.tools.find((t) => t.id === this.activeToolId);
      if (activeTool) {
        return activeTool;
      }
    }
    return group.tools[0];
  }

  private createToolButton(tool: ToolDef): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'tooltip tooltip-right';
    wrapper.setAttribute('data-tip', tool.label);

    const btn = document.createElement('button');
    btn.className = tool.id === this.activeToolId ? BTN_ACTIVE : BTN_BASE;
    btn.innerHTML = `<span class="[&>svg]:size-5">${tool.icon}</span>`;
    btn.addEventListener('click', () => this.handleToolClick(tool.id));

    wrapper.appendChild(btn);
    this.buttons.set(tool.id, btn);
    return wrapper;
  }

  private syncButtonStates(): void {
    for (const [id, btn] of this.buttons) {
      btn.className = id === this.activeToolId ? BTN_ACTIVE : BTN_BASE;
    }
  }

  private handleToolClick(toolId: ToolId): void {
    if (this.activeToolId === toolId) {
      this.onToolSelect(null);
    } else {
      this.onToolSelect(toolId);
    }
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape' && this.activeToolId) {
      e.preventDefault();
      e.stopPropagation();
      this.onToolSelect(null);
    }
  }
}
