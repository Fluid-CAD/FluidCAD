import { ICON_LINE, ICON_CIRCLE, ICON_CENTER_ARC, ICON_THREE_POINT_ARC, ICON_SCISSORS, ICON_CHEVRON_DOWN } from './icons';
import { ToolId } from '../interactive/sketch-tool';

type ToolDef = { id: ToolId; label: string; icon: string };
type ToolGroup = { tools: ToolDef[] };
type ToolEntry = ToolDef | ToolGroup;

function isGroup(entry: ToolEntry): entry is ToolGroup {
  return 'tools' in entry;
}

const TOOL_LAYOUT: ToolEntry[] = [
  { id: 'line', label: 'Line', icon: ICON_LINE },
  { tools: [
    { id: 'circle', label: 'Circle', icon: ICON_CIRCLE },
  ]},
  { tools: [
    { id: 'arc3', label: '3-Point Arc', icon: ICON_THREE_POINT_ARC },
    { id: 'arc2', label: 'Center Arc', icon: ICON_CENTER_ARC },
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
  private snapEl: HTMLDivElement;
  private onToolSelect: (toolId: ToolId | null) => void;
  private activeToolId: ToolId | null = null;
  private buttons = new Map<ToolId, HTMLButtonElement>();
  private expandedGroups = new Set<number>();
  private boundKeyDown: (e: KeyboardEvent) => void;

  onSnapVerticesChange: ((checked: boolean) => void) | null = null;
  onSnapGridChange: ((checked: boolean) => void) | null = null;

  constructor(toolbarHost: HTMLElement, snapContainer: HTMLElement, onToolSelect: (toolId: ToolId | null) => void) {
    this.onToolSelect = onToolSelect;

    this.el = document.createElement('div');
    this.el.className = 'absolute top-1/2 -translate-y-1/2 left-0 select-none pointer-events-auto';
    this.el.style.transition = 'transform 0.25s ease, opacity 0.25s ease';
    this.el.style.transform = 'translateX(-100%)';
    this.el.style.opacity = '0';

    this.inner = document.createElement('div');
    this.inner.className = 'flex flex-col gap-0.5 panel-bg border border-base-content/10 rounded-md p-1';
    this.el.appendChild(this.inner);

    this.snapEl = document.createElement('div');
    this.snapEl.className = 'absolute bottom-6 left-1/2 -translate-x-1/2 z-[999] pointer-events-auto select-none hidden';
    this.snapEl.style.transition = 'opacity 0.25s ease';
    const snapInner = document.createElement('div');
    snapInner.className = 'flex items-center gap-3 panel-bg border border-base-content/10 rounded-lg px-3 py-1.5';
    snapInner.innerHTML = `
      <label class="flex items-center gap-1.5 cursor-pointer" title="Snap to vertices">
        <input type="checkbox" class="checkbox checkbox-xs checkbox-primary" data-snap="vertex" checked />
        <span class="text-xs text-base-content/70">Vertices</span>
      </label>
      <label class="flex items-center gap-1.5 cursor-pointer" title="Snap to grid">
        <input type="checkbox" class="checkbox checkbox-xs checkbox-primary" data-snap="grid" checked />
        <span class="text-xs text-base-content/70">Grid</span>
      </label>
    `;
    this.snapEl.appendChild(snapInner);

    this.snapEl.querySelector<HTMLInputElement>('[data-snap="vertex"]')!.addEventListener('change', (e) => {
      this.onSnapVerticesChange?.((e.target as HTMLInputElement).checked);
    });
    this.snapEl.querySelector<HTMLInputElement>('[data-snap="grid"]')!.addEventListener('change', (e) => {
      this.onSnapGridChange?.((e.target as HTMLInputElement).checked);
    });

    this.renderTools();

    toolbarHost.appendChild(this.el);
    snapContainer.appendChild(this.snapEl);

    this.boundKeyDown = this.handleKeyDown.bind(this);
  }

  show(): void {
    this.el.style.transform = '';
    this.el.style.opacity = '';
    this.snapEl.classList.remove('hidden');
    window.addEventListener('keydown', this.boundKeyDown);
  }

  hide(): void {
    this.el.style.transform = 'translateX(-100%)';
    this.el.style.opacity = '0';
    this.snapEl.classList.add('hidden');
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
    return this.snapEl.querySelector<HTMLInputElement>('[data-snap="vertex"]')!.checked;
  }

  get snapGridChecked(): boolean {
    return this.snapEl.querySelector<HTMLInputElement>('[data-snap="grid"]')!.checked;
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
