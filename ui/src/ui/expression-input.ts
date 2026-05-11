const OFFSET_X = 16;
const OFFSET_Y = -36;

const IDENT_RE = /^[a-zA-Z_$][\w$]*$/;
const ASSIGNMENT_RE = /^([a-zA-Z_$][\w$]*)\s*=\s*(.+?)\s*;?\s*$/;
const RESERVED = new Set([
  'const', 'let', 'var', 'if', 'else', 'for', 'while', 'do', 'return', 'function',
  'class', 'new', 'this', 'true', 'false', 'null', 'undefined', 'typeof', 'instanceof',
  'switch', 'case', 'break', 'continue', 'default', 'try', 'catch', 'finally', 'throw',
  'in', 'of', 'delete', 'void', 'yield', 'async', 'await', 'import', 'export', 'from',
  'as', 'extends', 'super', 'static', 'enum', 'interface', 'implements', 'package',
  'private', 'protected', 'public',
]);

function isValidNewIdentifier(s: string): boolean {
  return IDENT_RE.test(s) && !RESERVED.has(s);
}

export type VariableInfo = { name: string; initializer?: string };

export type CommitResult = {
  expression: string;
  newVariable?: { name: string; initializer: string };
};

export type ExpressionInputOptions = {
  label: string;
  value: string;
  clientX: number;
  clientY: number;
  variables: VariableInfo[];
  onCommit: (result: CommitResult) => void;
  numericOnly?: boolean;
};

export class ExpressionInput {
  private el: HTMLDivElement;
  private wrapperEl: HTMLDivElement;
  private input: HTMLInputElement;
  private label: HTMLSpanElement;
  private dropdown: HTMLDivElement;
  private errorEl: HTMLDivElement;
  private onCommit: ((result: CommitResult) => void) | null = null;
  private visible = false;
  private userIsTyping = false;
  private variables: VariableInfo[] = [];
  private filteredVars: VariableInfo[] = [];
  private selectedIndex = -1;
  private seedValue = '';
  private errorVisible = false;
  private numericOnly = false;

  constructor(container: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'absolute z-[1000] pointer-events-auto hidden';
    this.el.innerHTML = `
      <div class="expression-wrapper flex items-center gap-1.5 panel-bg border border-base-content/10 rounded-md px-2 py-1 shadow-lg">
        <span class="text-xs text-base-content/50 select-none expression-label"></span>
        <input type="text" class="bg-transparent border-none outline-none text-sm text-base-content w-24 font-mono expression-input" />
      </div>
      <div class="mt-1 panel-bg border border-base-content/10 rounded-md shadow-lg max-h-[150px] overflow-y-auto hidden expression-dropdown"></div>
      <div class="mt-1 bg-red-500/90 text-white text-xs rounded-md px-2 py-1 shadow-lg hidden expression-error"></div>
    `;
    container.appendChild(this.el);

    this.wrapperEl = this.el.querySelector('.expression-wrapper')!;
    this.input = this.el.querySelector('.expression-input')!;
    this.label = this.el.querySelector('.expression-label')!;
    this.dropdown = this.el.querySelector('.expression-dropdown')!;
    this.errorEl = this.el.querySelector('.expression-error')!;

    this.input.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') {
        e.stopPropagation();
      }
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
      if (this.errorVisible) {
        this.clearInlineError();
      }
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
    this.numericOnly = opts.numericOnly ?? false;
    this.visible = true;
    this.userIsTyping = false;
    this.selectedIndex = -1;
    this.seedValue = opts.value;
    this.el.classList.remove('hidden');
    this.updatePosition(opts.clientX, opts.clientY);
    this.input.value = opts.value;
    this.input.focus();
    this.input.select();
    this.clearInlineError();
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
    this.clearInlineError();
    this.onCommit = null;
    this.input.blur();
  }

  get isVisible(): boolean {
    return this.visible;
  }

  containsElement(el: EventTarget | null): boolean {
    return el instanceof Node && this.el.contains(el);
  }

  updateValue(value: number | string): void {
    if (!this.visible || this.userIsTyping) {
      return;
    }
    const str = typeof value === 'string' ? value : String(Math.round(value * 100) / 100);
    this.input.value = str;
    this.seedValue = str;
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
    if (!val) {
      return false;
    }
    return this.runCommit(val);
  }

  private commit(): void {
    const val = this.input.value.trim();
    if (val) {
      this.runCommit(val);
    } else {
      this.hide();
    }
  }

  private runCommit(raw: string): boolean {
    if (!this.onCommit) {
      return false;
    }
    const classified = this.classifyCommit(raw);
    if (classified.kind === 'error') {
      this.showInlineError(classified.message);
      return false;
    }
    if (classified.kind === 'declare') {
      this.onCommit({
        expression: classified.name,
        newVariable: { name: classified.name, initializer: classified.initializer },
      });
    } else {
      this.onCommit({ expression: classified.expression });
    }
    this.hide();
    return true;
  }

  private classifyCommit(raw: string):
    | { kind: 'expression'; expression: string }
    | { kind: 'declare'; name: string; initializer: string }
    | { kind: 'error'; message: string } {
    if (this.numericOnly) {
      const num = parseFloat(raw);
      if (isNaN(num)) {
        return { kind: 'error', message: 'Enter a numeric value' };
      }
      return { kind: 'expression', expression: raw };
    }

    const assignMatch = raw.match(ASSIGNMENT_RE);
    if (assignMatch) {
      const name = assignMatch[1];
      const rhs = assignMatch[2].trim();
      if (!isValidNewIdentifier(name)) {
        return { kind: 'error', message: `'${name}' is not a valid name` };
      }
      if (this.variables.some((v) => v.name === name)) {
        return { kind: 'error', message: `'${name}' is already defined` };
      }
      if (!rhs) {
        return { kind: 'error', message: 'Missing value' };
      }
      return { kind: 'declare', name, initializer: rhs };
    }

    if (IDENT_RE.test(raw)) {
      if (this.variables.some((v) => v.name === raw)) {
        return { kind: 'expression', expression: raw };
      }
      if (!isValidNewIdentifier(raw)) {
        return { kind: 'expression', expression: raw };
      }
      const initializer = this.seedValue.trim();
      if (!initializer) {
        return { kind: 'error', message: 'No value to assign' };
      }
      return { kind: 'declare', name: raw, initializer };
    }

    return { kind: 'expression', expression: raw };
  }

  private showInlineError(msg: string): void {
    this.errorVisible = true;
    this.errorEl.textContent = msg;
    this.errorEl.classList.remove('hidden');
    this.wrapperEl.classList.add('border-red-500/70');
    this.wrapperEl.classList.remove('border-base-content/10');
  }

  private clearInlineError(): void {
    if (!this.errorVisible) {
      this.errorEl.classList.add('hidden');
      return;
    }
    this.errorVisible = false;
    this.errorEl.classList.add('hidden');
    this.errorEl.textContent = '';
    this.wrapperEl.classList.remove('border-red-500/70');
    this.wrapperEl.classList.add('border-base-content/10');
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
    if (this.numericOnly) {
      this.filteredVars = [];
      this.selectedIndex = -1;
      this.renderDropdown();
      return;
    }
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
