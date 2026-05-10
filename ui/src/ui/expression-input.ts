const OFFSET_X = 16;
const OFFSET_Y = -36;

export type VariableInfo = { name: string; initializer?: string };

export type ExpressionInputOptions = {
  label: string;
  value: string;
  clientX: number;
  clientY: number;
  variables: VariableInfo[];
  onCommit: (expression: string) => void;
};

export class ExpressionInput {
  private el: HTMLDivElement;
  private input: HTMLInputElement;
  private label: HTMLSpanElement;
  private dropdown: HTMLDivElement;
  private onCommit: ((expression: string) => void) | null = null;
  private visible = false;
  private userIsTyping = false;
  private variables: VariableInfo[] = [];
  private filteredVars: VariableInfo[] = [];
  private selectedIndex = -1;

  constructor(container: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'absolute z-[1000] pointer-events-auto hidden';
    this.el.innerHTML = `
      <div class="flex items-center gap-1.5 panel-bg border border-base-content/10 rounded-md px-2 py-1 shadow-lg">
        <span class="text-xs text-base-content/50 select-none expression-label"></span>
        <input type="text" class="bg-transparent border-none outline-none text-sm text-base-content w-24 font-mono expression-input" />
      </div>
      <div class="mt-1 panel-bg border border-base-content/10 rounded-md shadow-lg max-h-[150px] overflow-y-auto hidden expression-dropdown"></div>
    `;
    container.appendChild(this.el);

    this.input = this.el.querySelector('.expression-input')!;
    this.label = this.el.querySelector('.expression-label')!;
    this.dropdown = this.el.querySelector('.expression-dropdown')!;

    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.moveSelection(1);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        this.moveSelection(-1);
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        this.fillSelected();
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        if (this.selectedIndex >= 0 && this.selectedIndex < this.filteredVars.length) {
          this.input.value = this.filteredVars[this.selectedIndex].name;
        }
        this.commit();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        this.userIsTyping = false;
        this.input.blur();
        this.hide();
        return;
      }
    });

    this.input.addEventListener('input', () => {
      this.userIsTyping = true;
      this.filterAndRender();
    });

    this.input.addEventListener('focus', () => {
      this.filterAndRender();
    });

    this.input.addEventListener('mousedown', (e) => e.stopPropagation());
    this.input.addEventListener('mouseup', (e) => e.stopPropagation());
    this.input.addEventListener('click', (e) => e.stopPropagation());
    this.dropdown.addEventListener('mousedown', (e) => e.stopPropagation());
  }

  show(opts: ExpressionInputOptions): void {
    this.label.textContent = opts.label;
    this.onCommit = opts.onCommit;
    this.variables = opts.variables;
    this.visible = true;
    this.userIsTyping = false;
    this.selectedIndex = -1;
    this.el.classList.remove('hidden');
    this.updatePosition(opts.clientX, opts.clientY);
    this.input.value = opts.value;
    this.input.focus();
    this.input.select();
    this.filterAndRender();
  }

  hide(): void {
    if (!this.visible) {
      return;
    }
    this.visible = false;
    this.userIsTyping = false;
    this.el.classList.add('hidden');
    this.dropdown.classList.add('hidden');
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
    const val = this.input.value.trim();
    if (val && this.onCommit) {
      this.onCommit(val);
      return true;
    }
    return false;
  }

  private commit(): void {
    const val = this.input.value.trim();
    if (val) {
      this.onCommit?.(val);
    }
    this.hide();
  }

  private moveSelection(delta: number): void {
    if (this.filteredVars.length === 0) {
      return;
    }
    this.selectedIndex += delta;
    if (this.selectedIndex < 0) {
      this.selectedIndex = this.filteredVars.length - 1;
    } else if (this.selectedIndex >= this.filteredVars.length) {
      this.selectedIndex = 0;
    }
    this.renderDropdown();
  }

  private fillSelected(): void {
    if (this.selectedIndex >= 0 && this.selectedIndex < this.filteredVars.length) {
      this.input.value = this.filteredVars[this.selectedIndex].name;
      this.userIsTyping = true;
      this.filterAndRender();
    }
  }

  private filterAndRender(): void {
    if (!this.userIsTyping) {
      this.filteredVars = [...this.variables];
    } else {
      const query = this.input.value.trim().toLowerCase();
      if (!query) {
        this.filteredVars = [...this.variables];
      } else {
        this.filteredVars = this.variables.filter(
          (v) => v.name.toLowerCase().includes(query),
        );
      }
    }
    this.selectedIndex = -1;
    this.renderDropdown();
  }

  private renderDropdown(): void {
    if (this.filteredVars.length === 0) {
      this.dropdown.classList.add('hidden');
      return;
    }
    this.dropdown.classList.remove('hidden');
    this.dropdown.innerHTML = this.filteredVars
      .map((v, i) => {
        const active = i === this.selectedIndex ? 'bg-primary/10' : '';
        const hint = v.initializer ? `<span class="text-base-content/40 ml-2">= ${this.escapeHtml(this.truncate(v.initializer, 20))}</span>` : '';
        return `<div class="px-2 py-1 text-sm font-mono cursor-pointer hover:bg-primary/10 ${active}" data-idx="${i}">${this.escapeHtml(v.name)}${hint}</div>`;
      })
      .join('');

    this.dropdown.querySelectorAll('[data-idx]').forEach((item) => {
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const idx = parseInt((item as HTMLElement).dataset.idx!, 10);
        this.input.value = this.filteredVars[idx].name;
        this.commit();
      });
    });

    if (this.selectedIndex >= 0) {
      const activeEl = this.dropdown.children[this.selectedIndex] as HTMLElement;
      if (activeEl) {
        activeEl.scrollIntoView({ block: 'nearest' });
      }
    }
  }

  private escapeHtml(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  private truncate(str: string, max: number): string {
    return str.length > max ? str.slice(0, max) + '...' : str;
  }
}
