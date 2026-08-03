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
  ]},
  { tools: [
    { id: 'arc3', label: '3-Point Arc', caption: '3-Pt Arc', iconPng: 'arc' },
    { id: 'arc2', label: 'Center Arc', iconPng: 'carc' },
  ]},
  { tools: [
    { id: 'slot', label: 'Slot', iconPng: 'slot' },
  ]},
  { tools: [
    { id: 'fuse', label: 'Fuse', iconPng: 'fuse2d' },
    { id: 'subtract', label: 'Subtract', caption: 'Subtr.', iconPng: 'subtract2d' },
    { id: 'common', label: 'Common', iconPng: 'common2d' },
  ]},
  { tools: [
    { id: 'text', label: 'Text', iconPng: 'text' },
  ]},
  { tools: [
    { id: 'trim', label: 'Trim', iconPng: 'trim' },
    { id: 'fillet', label: 'Fillet', iconPng: 'fillet2d' },
    { id: 'offset', label: 'Offset', iconPng: 'offset' },
  ]},
  { tools: [
    { id: 'project', label: 'Project', iconPng: 'projection' },
  ]},
];

const TOOL_SHORTCUTS: Partial<Record<ToolId, string>> = {
  circle: 'c',
  rect: 'r',
  line: 'l',
  polygon: 'p',
  polyline: 'll',
  arc3: 'a',
  arc2: 'ca',
  bezier: 'b',
  trim: 't',
  fillet: 'f',
  offset: 'o',
  fuse: 'fu',
  subtract: 's',
  common: 'co',
  text: 'x',
  project: 'pj',
};

const BTN_BASE = 'btn btn-ghost btn-sm h-auto flex-col gap-0.5 px-2 py-1 shrink-0 text-base-content/60';
const BTN_ACTIVE = 'btn btn-soft btn-primary btn-sm h-auto flex-col gap-0.5 px-2 py-1 shrink-0';
/** Small muted caption under the toolbar icon. */
const BTN_LABEL = 'text-[10px] leading-none text-base-content/50';

export class SketchToolbar {
  private host: HTMLElement;
  private setGroupVisible: (visible: boolean) => void;
  private inner: HTMLDivElement;
  private onToolSelect: (toolId: ToolId | null) => void;
  private activeToolId: ToolId | null = null;
  private buttons = new Map<ToolId, HTMLButtonElement>();
  private shortcutManager: ShortcutManager;

  /** See `ShortcutManager.suspendWhile` — set by the sketch toolbar service
   * so the coordinate pill can claim printable keys. */
  set shortcutSuspend(fn: (() => boolean) | null) {
    this.shortcutManager.suspendWhile = fn;
  }
  private visible = false;

  private boundKeyDown: (e: KeyboardEvent) => void;
  private boundCloseRectMenu: (e: MouseEvent) => void;

  // Rectangle-button options; session-only state (deliberately not persisted).
  private rectMenu: HTMLDivElement | null = null;
  private rectRoundedState = false;
  private rectCenteredState = false;
  private rectButtonImg: HTMLImageElement | null = null;
  private rectTooltip: HTMLDivElement | null = null;

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
    this.inner = document.createElement('div');
    this.inner.className = 'flex flex-row items-center gap-0.5';
    this.host.appendChild(this.inner);

    this.renderTools();

    this.boundKeyDown = this.handleKeyDown.bind(this);
    this.boundCloseRectMenu = this.handleCloseRectMenu.bind(this);

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
    this.closeRectMenu();
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
    if (!SketchToolbar.isRectVariant(toolId)) {
      this.closeRectMenu();
    }
    this.syncButtonStates();
  }

  get activeTool(): ToolId | null {
    return this.activeToolId;
  }

  get rectCenteredChecked(): boolean {
    return this.rectCenteredState;
  }

  private static isRectVariant(toolId: ToolId | null): boolean {
    return toolId === 'rect' || toolId === 'rounded-rect';
  }

  /** The tool the merged Rectangle button activates, per the Rounded toggle. */
  private effectiveRectToolId(): ToolId {
    return this.rectRoundedState ? 'rounded-rect' : 'rect';
  }

  private static createDropdownMenu(align: string): HTMLDivElement {
    const menu = document.createElement('div');
    menu.className = `absolute top-full ${align} mt-2 z-[200] panel-bg border border-base-content/10 rounded-md shadow-[0_4px_12px_rgba(0,0,0,0.4)] p-2 flex flex-col gap-2 whitespace-nowrap`;
    return menu;
  }

  private static buildMenuToggle(text: string, checked: boolean, onChange: (checked: boolean) => void): HTMLLabelElement {
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'toggle toggle-xs toggle-primary';
    checkbox.checked = checked;
    checkbox.addEventListener('change', () => onChange(checkbox.checked));
    const label = document.createElement('label');
    label.className = 'flex items-center gap-2 cursor-pointer';
    // Toggle without taking keyboard focus: the coordinate chip listens at the
    // window and ignores keystrokes targeted at an <input>, so a focused
    // checkbox would swallow the digits meant for the X field.
    label.addEventListener('mousedown', (e) => e.preventDefault());
    label.appendChild(checkbox);
    const span = document.createElement('span');
    span.className = 'text-xs text-base-content/70';
    span.textContent = text;
    label.appendChild(span);
    return label;
  }

  // Dropdown on the merged Rectangle button: two session-only toggles that
  // pick the variant (Rounded → rounded-rect tool) and the anchor mode
  // (Centered → `.centered()` on the emitted statement). Toggling while the
  // tool is active reselects it so the new options take effect immediately.
  private openRectMenu(anchor: HTMLElement): void {
    this.closeRectMenu();

    const menu = SketchToolbar.createDropdownMenu('left-1/2 -translate-x-1/2');

    menu.appendChild(SketchToolbar.buildMenuToggle('Rounded', this.rectRoundedState, (checked) => {
      this.rectRoundedState = checked;
      this.updateRectButtonDisplay();
      this.reselectRectToolIfActive();
    }));
    menu.appendChild(SketchToolbar.buildMenuToggle('Centered', this.rectCenteredState, (checked) => {
      this.rectCenteredState = checked;
      this.reselectRectToolIfActive();
    }));

    anchor.appendChild(menu);
    this.rectMenu = menu;
    // The hover tooltip occupies the same spot below the button; keep it out
    // of the way while the menu is open.
    if (this.rectTooltip) {
      this.rectTooltip.style.display = 'none';
    }

    setTimeout(() => document.addEventListener('click', this.boundCloseRectMenu), 0);
  }

  private closeRectMenu(): void {
    if (this.rectMenu) {
      this.rectMenu.remove();
      this.rectMenu = null;
      document.removeEventListener('click', this.boundCloseRectMenu);
      if (this.rectTooltip) {
        this.rectTooltip.style.display = '';
      }
    }
  }

  private handleCloseRectMenu(e: MouseEvent): void {
    if (this.rectMenu && !this.rectMenu.contains(e.target as Node) && !this.rectMenu.parentElement?.contains(e.target as Node)) {
      this.closeRectMenu();
    }
  }

  private reselectRectToolIfActive(): void {
    if (SketchToolbar.isRectVariant(this.activeToolId)) {
      this.onToolSelect(this.effectiveRectToolId());
    }
  }

  private updateRectButtonDisplay(): void {
    if (this.rectButtonImg) {
      this.rectButtonImg.src = `/icons/${this.rectRoundedState ? 'rounded-rect' : 'rect'}.png`;
    }
    if (this.rectTooltip) {
      const label = this.rectRoundedState ? 'Rounded Rectangle' : 'Rectangle';
      this.rectTooltip.innerHTML = `${label} <kbd class="kbd kbd-xs">${TOOL_SHORTCUTS.rect}</kbd>`;
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
    wrapper.className = 'relative group shrink-0';

    const btn = document.createElement('button');
    btn.className = tool.id === this.activeToolId ? BTN_ACTIVE : BTN_BASE;
    btn.innerHTML = `<img src="/icons/${tool.iconPng}.png" ${ICON_IMG_FALLBACK} class="w-8 h-8 object-contain shrink-0" alt="" />`
      + `<span class="${BTN_LABEL}">${tool.caption ?? tool.label}</span>`;
    if (tool.id === 'rect') {
      btn.addEventListener('click', () => this.handleRectButtonClick(wrapper));
    } else {
      btn.addEventListener('click', () => this.handleToolClick(tool.id));
    }

    const shortcut = TOOL_SHORTCUTS[tool.id];
    const tip = document.createElement('div');
    tip.className = 'absolute top-full left-1/2 -translate-x-1/2 mt-2 px-2 py-1 rounded bg-base-300 text-base-content text-xs whitespace-nowrap opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity flex items-center gap-1.5 z-[200]';
    tip.innerHTML = shortcut
      ? `${tool.label} <kbd class="kbd kbd-xs">${shortcut}</kbd>`
      : tool.label;

    wrapper.appendChild(btn);
    wrapper.appendChild(tip);
    this.buttons.set(tool.id, btn);
    if (tool.id === 'rect') {
      this.rectButtonImg = btn.querySelector('img');
      this.rectTooltip = tip;
      this.updateRectButtonDisplay();
    }
    return wrapper;
  }

  private syncButtonStates(): void {
    const highlighted = SketchToolbar.isRectVariant(this.activeToolId) ? 'rect' : this.activeToolId;
    for (const [id, btn] of this.buttons) {
      btn.className = id === highlighted ? BTN_ACTIVE : BTN_BASE;
    }
  }

  private handleToolClick(toolId: ToolId): void {
    if (toolId === 'rect') {
      // Keyboard path: same activate/deselect toggle, but no dropdown.
      if (SketchToolbar.isRectVariant(this.activeToolId)) {
        this.onToolSelect(null);
      } else {
        this.onToolSelect(this.effectiveRectToolId());
      }
      return;
    }
    if (this.activeToolId === toolId) {
      this.onToolSelect(null);
    } else {
      this.onToolSelect(toolId);
    }
  }

  private handleRectButtonClick(anchor: HTMLElement): void {
    if (SketchToolbar.isRectVariant(this.activeToolId)) {
      this.onToolSelect(null);
      this.closeRectMenu();
    } else {
      this.onToolSelect(this.effectiveRectToolId());
      this.openRectMenu(anchor);
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
