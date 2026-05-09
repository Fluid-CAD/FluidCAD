import { ICON_LINE, ICON_CIRCLE, ICON_SCISSORS } from './icons';
import { ToolId } from '../interactive/sketch-tool';

type ToolDef = { id: ToolId; label: string; icon: string };

const TOOLS: ToolDef[] = [
  { id: 'line', label: 'Line', icon: ICON_LINE },
  { id: 'circle', label: 'Circle', icon: ICON_CIRCLE },
  { id: 'trim', label: 'Trim', icon: ICON_SCISSORS },
];

const BTN_BASE = 'btn btn-ghost btn-square btn-sm text-base-content/60';
const BTN_ACTIVE = 'btn btn-soft btn-primary btn-square btn-sm';

export class SketchToolbar {
  private el: HTMLDivElement;
  private onToolSelect: (toolId: ToolId | null) => void;
  private activeToolId: ToolId | null = null;
  private buttons = new Map<ToolId, HTMLButtonElement>();
  private boundKeyDown: (e: KeyboardEvent) => void;

  constructor(container: HTMLElement, onToolSelect: (toolId: ToolId | null) => void) {
    this.onToolSelect = onToolSelect;

    this.el = document.createElement('div');
    this.el.className = 'absolute bottom-6 left-1/2 -translate-x-1/2 z-[999] pointer-events-auto hidden select-none';

    const inner = document.createElement('div');
    inner.className = 'flex items-center gap-1 panel-bg border border-base-content/10 rounded-lg p-1';

    for (const tool of TOOLS) {
      const btn = document.createElement('button');
      btn.className = BTN_BASE;
      btn.title = tool.label;
      btn.innerHTML = `<span class="[&>svg]:size-5">${tool.icon}</span>`;
      btn.addEventListener('click', () => this.handleToolClick(tool.id));
      inner.appendChild(btn);
      this.buttons.set(tool.id, btn);
    }

    this.el.appendChild(inner);
    container.appendChild(this.el);

    this.boundKeyDown = this.handleKeyDown.bind(this);
  }

  show(): void {
    this.el.classList.remove('hidden');
    window.addEventListener('keydown', this.boundKeyDown);
  }

  hide(): void {
    this.el.classList.add('hidden');
    window.removeEventListener('keydown', this.boundKeyDown);
    if (this.activeToolId) {
      this.setActiveTool(null);
    }
  }

  get isVisible(): boolean {
    return !this.el.classList.contains('hidden');
  }

  setActiveTool(toolId: ToolId | null): void {
    if (this.activeToolId === toolId) {
      return;
    }
    for (const [id, btn] of this.buttons) {
      btn.className = id === toolId ? BTN_ACTIVE : BTN_BASE;
    }
    this.activeToolId = toolId;
  }

  get activeTool(): ToolId | null {
    return this.activeToolId;
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
