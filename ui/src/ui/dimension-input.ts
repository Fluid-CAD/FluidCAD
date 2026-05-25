const OFFSET_X = 16;
const OFFSET_Y = -36;

export class DimensionInput {
  private el: HTMLDivElement;
  private input: HTMLInputElement;
  private label: HTMLSpanElement;
  private onCommit: ((value: number) => void) | null = null;
  private visible = false;
  private userIsTyping = false;

  constructor(container: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'absolute z-[1000] pointer-events-auto hidden';
    this.el.innerHTML = `
      <div class="flex items-center gap-1.5 panel-bg border border-base-content/10 rounded-md px-2 py-1 shadow-lg">
        <span class="text-xs text-base-content/50 select-none dimension-label"></span>
        <input type="text" class="bg-transparent border-none outline-none text-sm text-base-content w-16 font-mono dimension-input" />
      </div>
    `;
    container.appendChild(this.el);

    this.input = this.el.querySelector('.dimension-input')!;
    this.label = this.el.querySelector('.dimension-label')!;

    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        const val = parseFloat(this.input.value);
        if (!isNaN(val) && val > 0) {
          this.onCommit?.(val);
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        this.userIsTyping = false;
        this.input.blur();
      }
    });

    this.input.addEventListener('input', () => {
      this.userIsTyping = true;
    });

    this.input.addEventListener('mousedown', (e) => e.stopPropagation());
    this.input.addEventListener('mouseup', (e) => e.stopPropagation());
    this.input.addEventListener('click', (e) => e.stopPropagation());
  }

  show(label: string, value: number, clientX: number, clientY: number, onCommit: (value: number) => void): void {
    this.label.textContent = label;
    this.onCommit = onCommit;
    this.visible = true;
    this.userIsTyping = false;
    this.el.classList.remove('hidden');
    this.updatePosition(clientX, clientY);
    this.input.value = String(Math.round(value * 100) / 100);
    this.input.focus();
    this.input.select();
  }

  hide(): void {
    if (!this.visible) {
      return;
    }
    this.visible = false;
    this.userIsTyping = false;
    this.el.classList.add('hidden');
    this.onCommit = null;
    this.input.blur();
  }

  get isVisible(): boolean {
    return this.visible;
  }

  updateValue(value: number): void {
    if (!this.visible || this.userIsTyping) {
      return;
    }
    this.input.value = String(Math.round(value * 100) / 100);
    this.input.select();
  }

  updatePosition(clientX: number, clientY: number): void {
    if (!this.visible) {
      return;
    }
    const container = this.el.parentElement!;
    const rect = container.getBoundingClientRect();
    this.el.style.left = `${clientX - rect.left + OFFSET_X}px`;
    this.el.style.top = `${clientY - rect.top + OFFSET_Y}px`;
  }

  commitCurrentValue(): boolean {
    const val = parseFloat(this.input.value);
    if (!isNaN(val) && val > 0 && this.onCommit) {
      this.onCommit(val);
      return true;
    }
    return false;
  }
}
