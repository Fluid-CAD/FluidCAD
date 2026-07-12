import { ICON_SETTINGS } from './icons';
import { ICON_IMG_FALLBACK } from './object-icons';
import { ToolId } from '../interactive/sketch-tool';
import { ShortcutManager } from './shortcut-manager';

/**
 * Each tool renders a PNG from `/icons` (the same artwork the timeline uses —
 * `iconPng` is the file's basename). `caption` overrides the text shown under
 * the icon when `label` is too long for a button (the full `label` still
 * drives the hover tooltip).
 */
type ToolDef = { id: ToolId; label: string; caption?: string; iconPng: string };
type ToolGroup = { tools: ToolDef[] };
type ToolEntry = ToolDef | ToolGroup;

function isGroup(entry: ToolEntry): entry is ToolGroup {
  return 'tools' in entry;
}

const TOOL_LAYOUT: ToolEntry[] = [
  { tools: [
    { id: 'line', label: 'Line', iconPng: 'line' },
    { id: 'polyline', label: 'Polyline', iconPng: 'wire' },
    { id: 'bezier', label: 'Bezier', iconPng: 'bezier' },
  ]},
  { tools: [
    { id: 'circle', label: 'Circle', iconPng: 'circle' },
    { id: 'polygon', label: 'Polygon', iconPng: 'polygon' },
  ]},
  { tools: [
    { id: 'rect', label: 'Rectangle', iconPng: 'rect' },
    { id: 'rounded-rect', label: 'Rounded Rectangle', caption: 'Rounded', iconPng: 'rounded-rect' },
  ]},
  { tools: [
    { id: 'arc3', label: '3-Point Arc', caption: '3-Pt Arc', iconPng: 'arc' },
    { id: 'arc2', label: 'Center Arc', iconPng: 'carc' },
  ]},
  { tools: [
    { id: 'slot', label: 'Slot', iconPng: 'slot' },
  ]},
  { tools: [
    { id: 'trim', label: 'Trim', iconPng: 'trim' },
  ]},
];

const TOOL_SHORTCUTS: Partial<Record<ToolId, string>> = {
  circle: 'c',
  rect: 'r',
  'rounded-rect': 'rr',
  line: 'l',
  polygon: 'p',
  polyline: 'll',
  arc3: 'a',
  arc2: 'ca',
  bezier: 'b',
  trim: 't',
};

const BTN_BASE = 'btn btn-ghost btn-sm h-auto flex-col gap-0.5 px-2 py-1 text-base-content/60';
const BTN_ACTIVE = 'btn btn-soft btn-primary btn-sm h-auto flex-col gap-0.5 px-2 py-1';
/** Small muted caption under the toolbar icon. */
const BTN_LABEL = 'text-[10px] leading-none text-base-content/50';

export class SketchToolbar {
  private host: HTMLElement;
  private setGroupVisible: (visible: boolean) => void;
  private inner: HTMLDivElement;
  private snapMenu: HTMLDivElement | null = null;
  private onToolSelect: (toolId: ToolId | null) => void;
  private activeToolId: ToolId | null = null;
  private buttons = new Map<ToolId, HTMLButtonElement>();
  private shortcutManager: ShortcutManager;
  private visible = false;

  private boundKeyDown: (e: KeyboardEvent) => void;
  private boundCloseSnapMenu: (e: MouseEvent) => void;
  private snapVertexCheckedState = true;
  private snapGridCheckedState = true;

  onSnapVerticesChange: ((checked: boolean) => void) | null = null;
  onSnapGridChange: ((checked: boolean) => void) | null = null;

  constructor(
    host: HTMLElement,
    onToolSelect: (toolId: ToolId | null) => void,
    setGroupVisible: (visible: boolean) => void,
  ) {
    this.onToolSelect = onToolSelect;
    this.host = host;
    this.setGroupVisible = setGroupVisible;

    // The sketch tools group, rendered directly into its navbar group host.
    // The group's DOM visibility is owned by the navbar (which also reflows the
    // inter-group dividers); this class only decides *when* via show()/hide().
    // Layout: drawing tools first, then the snap-settings cog on the right.
    this.inner = document.createElement('div');
    this.inner.className = 'flex flex-row items-center gap-0.5';
    this.host.appendChild(this.inner);

    this.renderTools();

    const sep = document.createElement('div');
    sep.className = 'w-px h-8 bg-base-content/[0.12] mx-0.5 shrink-0';
    this.host.appendChild(sep);

    this.buildSnapButton();

    this.boundKeyDown = this.handleKeyDown.bind(this);
    this.boundCloseSnapMenu = this.handleCloseSnapMenu.bind(this);

    this.shortcutManager = new ShortcutManager({ timeout: 200 });
    for (const [toolId, keys] of Object.entries(TOOL_SHORTCUTS)) {
      this.shortcutManager.register(keys, () => this.handleToolClick(toolId as ToolId));
    }
  }

  show(): void {
    this.visible = true;
    this.setGroupVisible(true);
    window.addEventListener('keydown', this.boundKeyDown);
    this.shortcutManager.enable();
  }

  hide(): void {
    this.visible = false;
    this.setGroupVisible(false);
    this.closeSnapMenu();
    window.removeEventListener('keydown', this.boundKeyDown);
    this.shortcutManager.disable();
    if (this.activeToolId) {
      this.setActiveTool(null);
    }
  }

  get isVisible(): boolean {
    return this.visible;
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
    cogBtn.innerHTML = `<span class="[&>svg]:size-8">${ICON_SETTINGS}</span><span class="${BTN_LABEL}">Snap</span>`;
    cogBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.snapMenu) {
        this.closeSnapMenu();
      } else {
        this.openSnapMenu(cogWrapper);
      }
    });
    cogWrapper.appendChild(cogBtn);

    this.host.appendChild(cogWrapper);
  }

  private openSnapMenu(anchor: HTMLElement): void {
    this.closeSnapMenu();

    const menu = document.createElement('div');
    menu.className = 'absolute top-full right-0 mt-2 z-[200] panel-bg border border-base-content/10 rounded-md shadow-[0_4px_12px_rgba(0,0,0,0.4)] p-2 flex flex-col gap-2 whitespace-nowrap';

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
        sep.className = 'w-px h-8 bg-base-content/[0.12] mx-0.5 shrink-0';
        this.inner.appendChild(sep);
      }

      const entry = TOOL_LAYOUT[i];
      const tools = isGroup(entry) ? entry.tools : [entry];
      for (const tool of tools) {
        this.inner.appendChild(this.createToolButton(tool));
      }
    }
  }

  private createToolButton(tool: ToolDef): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'relative group';

    const btn = document.createElement('button');
    btn.className = tool.id === this.activeToolId ? BTN_ACTIVE : BTN_BASE;
    btn.innerHTML = `<img src="/icons/${tool.iconPng}.png" ${ICON_IMG_FALLBACK} class="w-8 h-8 object-contain" alt="" />`
      + `<span class="${BTN_LABEL}">${tool.caption ?? tool.label}</span>`;
    btn.addEventListener('click', () => this.handleToolClick(tool.id));

    const shortcut = TOOL_SHORTCUTS[tool.id];
    const tip = document.createElement('div');
    tip.className = 'absolute top-full left-1/2 -translate-x-1/2 mt-2 px-2 py-1 rounded bg-base-300 text-base-content text-xs whitespace-nowrap opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity flex items-center gap-1.5 z-[200]';
    tip.innerHTML = shortcut
      ? `${tool.label} <kbd class="kbd kbd-xs">${shortcut}</kbd>`
      : tool.label;

    wrapper.appendChild(btn);
    wrapper.appendChild(tip);
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
