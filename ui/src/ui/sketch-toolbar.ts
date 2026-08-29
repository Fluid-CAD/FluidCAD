import { ICON_IMG_FALLBACK } from './object-icons';
import { ToolId } from '../interactive/sketch-tool';
import { ShortcutManager } from './shortcut-manager';
import {
  TOOLBAR_BTN_ACTIVE, TOOLBAR_BTN_ACTIVE_STRONG, TOOLBAR_BTN_BASE, TOOLBAR_BTN_ICON, TOOLBAR_BTN_LABEL,
} from './toolbar-styles';

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
    { id: 'text', label: 'Text', iconPng: 'text' },
  ]},
  { tools: [
    { id: 'fillet', label: 'Fillet', iconPng: 'fillet2d' },
    { id: 'offset', label: 'Offset', iconPng: 'offset' },
    { id: 'project', label: 'Project', iconPng: 'projection' },
  ]},
  { tools: [
    { id: 'copy', label: 'Copy', iconPng: 'copy-linear2d' },
    { id: 'rotate', label: 'Rotate', iconPng: 'rotate2d' },
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
  fillet: 'f',
  offset: 'o',
  copy: 'cp',
  rotate: 'ro',
  text: 'x',
  project: 'pj',
};

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
  private boundClosePolygonMenu: (e: MouseEvent) => void;

  // Rectangle-button options; session-only state (deliberately not persisted).
  private rectMenu: HTMLDivElement | null = null;
  private rectRoundedState = false;
  private rectCenteredState = false;
  private rectButtonImg: HTMLImageElement | null = null;
  private rectTooltip: HTMLDivElement | null = null;

  // Polygon-button options; session-only state (deliberately not persisted).
  private polygonMenu: HTMLDivElement | null = null;
  private polygonModeState: 'circumscribed' | 'inscribed' = 'circumscribed';
  private polygonTooltip: HTMLDivElement | null = null;

  /**
   * Guide mode: a latch, not a tool — it rides alongside whatever tool is
   * armed instead of joining the radio group, and every statement drawn while
   * it is on gains a `.guide()` suffix. Dropped when the toolbar hides so a
   * new sketch session never starts silently in construction mode. The press
   * itself is delegated: with edges selected, the service converts them
   * one-shot instead of flipping the latch.
   */
  private guideModeState = false;
  private guideButton: HTMLButtonElement | null = null;
  private onGuidePress: () => void;

  constructor(
    host: HTMLElement,
    onToolSelect: (toolId: ToolId | null) => void,
    setGroupVisible: (visible: boolean) => void,
    onGuidePress: () => void,
  ) {
    this.onToolSelect = onToolSelect;
    this.onGuidePress = onGuidePress;
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
    this.boundClosePolygonMenu = this.handleClosePolygonMenu.bind(this);

    this.shortcutManager = new ShortcutManager({ timeout: 200 });
    for (const [toolId, keys] of Object.entries(TOOL_SHORTCUTS)) {
      this.shortcutManager.register(keys, () => this.handleToolClick(toolId as ToolId));
    }
    this.shortcutManager.register('g', () => this.onGuidePress());
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
    this.closePolygonMenu();
    window.removeEventListener('keydown', this.boundKeyDown);
    this.shortcutManager.disable();
    if (this.activeToolId) {
      this.setActiveTool(null);
    }
    if (this.guideModeState) {
      // Silent reset — the sketch is going away, so there is no selection to
      // convert and no service state to unwind.
      this.guideModeState = false;
      this.syncGuideButtonState();
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
    if (toolId !== 'polygon') {
      this.closePolygonMenu();
    }
    this.syncButtonStates();
  }

  get activeTool(): ToolId | null {
    return this.activeToolId;
  }

  get rectCenteredChecked(): boolean {
    return this.rectCenteredState;
  }

  get polygonModeChecked(): 'circumscribed' | 'inscribed' {
    return this.polygonModeState;
  }

  get guideModeChecked(): boolean {
    return this.guideModeState;
  }

  /** Latch (or release) guide mode; the service owns the press decision. */
  setGuideMode(active: boolean): void {
    if (this.guideModeState === active) {
      return;
    }
    this.guideModeState = active;
    this.syncGuideButtonState();
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

  private static buildMenuRadio(
    text: string,
    name: string,
    checked: boolean,
    onSelect: () => void,
  ): HTMLLabelElement {
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = name;
    radio.className = 'radio radio-xs radio-primary';
    radio.checked = checked;
    radio.addEventListener('change', () => {
      if (radio.checked) {
        onSelect();
      }
    });
    const label = document.createElement('label');
    label.className = 'flex items-center gap-2 cursor-pointer';
    // Select without taking keyboard focus: the coordinate chip listens at the
    // window and ignores keystrokes targeted at an <input>, so a focused
    // radio would swallow the digits meant for the X field.
    label.addEventListener('mousedown', (e) => e.preventDefault());
    label.appendChild(radio);
    const span = document.createElement('span');
    span.className = 'text-xs text-base-content/70';
    span.textContent = text;
    label.appendChild(span);
    return label;
  }

  // Dropdown on the Polygon button: a session-only radio pair picking where
  // the guide circle sits — Circumscribed draws the sides tangent around it,
  // Inscribed puts the vertices on it. Switching while the tool is active
  // reselects it so the new mode takes effect immediately.
  private openPolygonMenu(anchor: HTMLElement): void {
    this.closePolygonMenu();

    const menu = SketchToolbar.createDropdownMenu('left-1/2 -translate-x-1/2');

    const modes = [
      { text: 'Circumscribed', value: 'circumscribed' as const },
      { text: 'Inscribed', value: 'inscribed' as const },
    ];
    for (const mode of modes) {
      menu.appendChild(SketchToolbar.buildMenuRadio(
        mode.text,
        'polygon-mode',
        this.polygonModeState === mode.value,
        () => {
          this.polygonModeState = mode.value;
          if (this.activeToolId === 'polygon') {
            this.onToolSelect('polygon');
          }
        },
      ));
    }

    anchor.appendChild(menu);
    this.polygonMenu = menu;
    // The hover tooltip occupies the same spot below the button; keep it out
    // of the way while the menu is open.
    if (this.polygonTooltip) {
      this.polygonTooltip.style.display = 'none';
    }

    setTimeout(() => document.addEventListener('click', this.boundClosePolygonMenu), 0);
  }

  private closePolygonMenu(): void {
    if (this.polygonMenu) {
      this.polygonMenu.remove();
      this.polygonMenu = null;
      document.removeEventListener('click', this.boundClosePolygonMenu);
      if (this.polygonTooltip) {
        this.polygonTooltip.style.display = '';
      }
    }
  }

  private handleClosePolygonMenu(e: MouseEvent): void {
    if (this.polygonMenu && !this.polygonMenu.contains(e.target as Node) && !this.polygonMenu.parentElement?.contains(e.target as Node)) {
      this.closePolygonMenu();
    }
  }

  private handlePolygonButtonClick(anchor: HTMLElement): void {
    if (this.activeToolId === 'polygon') {
      this.onToolSelect(null);
      this.closePolygonMenu();
    } else {
      this.onToolSelect('polygon');
      this.openPolygonMenu(anchor);
    }
  }

  // Dropdown on the merged Rectangle button: two session-only toggles that
  // pick the variant (Rounded → rounded-rect tool) and the anchor mode
  // (Centered picks the anchor the gesture grows from). Toggling while the
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

    // The Guide latch lives in its own trailing group — it is a mode over the
    // other tools, not a member of their radio.
    const sep = document.createElement('div');
    sep.className = 'w-px h-8 bg-base-content/[0.12] mx-0.5 shrink-0';
    this.inner.appendChild(sep);
    this.inner.appendChild(this.createGuideButton());
  }

  private createGuideButton(): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'relative group shrink-0';

    const btn = document.createElement('button');
    btn.className = this.guideModeState ? TOOLBAR_BTN_ACTIVE_STRONG : TOOLBAR_BTN_BASE;
    btn.innerHTML = `<img src="/icons/guide.png" ${ICON_IMG_FALLBACK} class="${TOOLBAR_BTN_ICON}" alt="" />`
      + `<span class="${TOOLBAR_BTN_LABEL}">Guide</span>`;
    btn.addEventListener('click', () => this.onGuidePress());

    const tip = document.createElement('div');
    tip.className = 'absolute top-full left-1/2 -translate-x-1/2 mt-2 px-2 py-1 rounded bg-base-300 text-base-content text-xs whitespace-nowrap opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity flex items-center gap-1.5 z-[200]';
    tip.innerHTML = 'Guide mode (construction geometry) <kbd class="kbd kbd-xs">g</kbd>';

    wrapper.appendChild(btn);
    wrapper.appendChild(tip);
    this.guideButton = btn;
    return wrapper;
  }

  private syncGuideButtonState(): void {
    if (this.guideButton) {
      this.guideButton.className = this.guideModeState ? TOOLBAR_BTN_ACTIVE_STRONG : TOOLBAR_BTN_BASE;
    }
  }

  private createToolButton(tool: ToolDef): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'relative group shrink-0';

    const btn = document.createElement('button');
    btn.className = tool.id === this.activeToolId ? TOOLBAR_BTN_ACTIVE : TOOLBAR_BTN_BASE;
    btn.innerHTML = `<img src="/icons/${tool.iconPng}.png" ${ICON_IMG_FALLBACK} class="${TOOLBAR_BTN_ICON}" alt="" />`
      + `<span class="${TOOLBAR_BTN_LABEL}">${tool.caption ?? tool.label}</span>`;
    if (tool.id === 'rect') {
      btn.addEventListener('click', () => this.handleRectButtonClick(wrapper));
    } else if (tool.id === 'polygon') {
      btn.addEventListener('click', () => this.handlePolygonButtonClick(wrapper));
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
    if (tool.id === 'polygon') {
      this.polygonTooltip = tip;
    }
    return wrapper;
  }

  private syncButtonStates(): void {
    const highlighted = SketchToolbar.isRectVariant(this.activeToolId) ? 'rect' : this.activeToolId;
    for (const [id, btn] of this.buttons) {
      btn.className = id === highlighted ? TOOLBAR_BTN_ACTIVE : TOOLBAR_BTN_BASE;
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
