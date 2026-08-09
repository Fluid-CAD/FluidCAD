import {
  applyVariableName, classifyCommit, declaredVariableName, filterSuggestions,
  suggestionItemHtml, trailingIdentifier, Suggestion, VariableInfo,
} from './expression-core';

export type { VariableInfo };

const OFFSET_X = 16;
const OFFSET_Y = -36;

export type CommitResult = {
  expression: string;
  newVariable?: { name: string; initializer: string };
};

export type ExpressionInputOptions = {
  label: string;
  /** The field's opening value — a plain number; it seeds any new variable
   * declared over it. An existing source expression is shown with
   * `seedExpression` instead. */
  value: string;
  clientX: number;
  clientY: number;
  variables: VariableInfo[];
  onCommit: (result: CommitResult) => void;
  numericOnly?: boolean;
  /** Declarations disabled; the committed text must evaluate to a finite
   * number (arithmetic over `variables`). The host writes numbers, not
   * source expressions. */
  arithmeticOnly?: boolean;
};

export class ExpressionInput {
  private el: HTMLDivElement;
  private wrapperEl: HTMLDivElement;
  private input: HTMLInputElement;
  private label: HTMLSpanElement;
  private dropdown: HTMLDivElement;
  private errorEl: HTMLDivElement;
  private paramBtn: HTMLButtonElement;
  private paramMode = false;
  private paramAvailable = false;
  private onCommit: ((result: CommitResult) => void) | null = null;
  private visible = false;
  private userIsTyping = false;
  private variables: VariableInfo[] = [];
  private filteredVars: Suggestion[] = [];
  private selectedIndex = -1;
  /** The last plain-number text the field held — a new variable's initializer.
   * Never an expression: see `seedExpression`. */
  private seedValue = '';
  private errorVisible = false;
  private numericOnly = false;
  private arithmeticOnly = false;

  onSpaceOverride: (() => void) | null = null;

  constructor(container: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'absolute z-[1000] pointer-events-auto hidden';
    this.el.innerHTML = `
      <div class="expression-wrapper flex items-center gap-1.5 panel-bg border border-base-content/10 rounded-md px-2 py-1 shadow-lg">
        <span class="text-xs text-base-content/50 select-none expression-label"></span>
        <input type="text" class="bg-transparent border-none outline-none text-sm text-base-content w-24 font-mono expression-input" />
        <button type="button" tabindex="-1" title="Declare as parameter — param()"
          class="hidden shrink-0 w-5 h-5 rounded text-xs font-mono font-semibold border cursor-pointer select-none expression-param-btn"></button>
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
    this.paramBtn = this.el.querySelector('.expression-param-btn')!;
    this.paramBtn.textContent = 'P';
    this.renderParamButton();

    // mousedown would blur the input; toggle without stealing focus.
    this.paramBtn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.paramMode = !this.paramMode;
      this.renderParamButton();
    });

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
          this.applyVariableName(this.filteredVars[this.selectedIndex].name);
        }
        this.commit();
        return;
      }
      if (e.key === ' ' && this.onSpaceOverride) {
        e.preventDefault();
        this.onSpaceOverride();
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
      // An emptied field resumes live value updates from the mouse.
      this.userIsTyping = this.input.value.length > 0;
      if (this.errorVisible) {
        this.clearInlineError();
      }
      this.updateParamAvailability();
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
    this.arithmeticOnly = opts.arithmeticOnly ?? false;
    this.visible = true;
    this.userIsTyping = false;
    this.selectedIndex = -1;
    this.paramMode = false;
    this.seedValue = opts.value;
    this.el.classList.remove('hidden');
    this.updatePosition(opts.clientX, opts.clientY);
    this.input.value = opts.value;
    this.input.focus();
    this.input.select();
    this.clearInlineError();
    this.updateParamAvailability();
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

  /** The geometry's live value while drawing or dragging — fills the field and
   * seeds the initializer a new variable would be declared with. */
  updateValue(value: number): void {
    if (!this.visible) {
      return;
    }
    const str = String(Math.round(value * 100) / 100);
    this.seedValue = str;
    if (this.userIsTyping) {
      // Keep the typed text, but the new-variable suggestion tracks the live value.
      this.filterAndRender(true);
      return;
    }
    this.input.value = str;
    this.input.select();
    this.updateParamAvailability();
  }

  /**
   * The dimension's existing source expression, seeded once the code read
   * resolves behind a double-click. Text only: the seed keeps the numeric
   * value the field opened with, so naming this dimension declares the number
   * rather than a copy of the expression — a `param()` lands at the top of the
   * file, above anything the expression could reference.
   */
  seedExpression(expression: string): void {
    if (!this.visible || this.userIsTyping) {
      return;
    }
    this.input.value = expression;
    this.input.select();
    this.updateParamAvailability();
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
    const asParam = this.paramMode && this.paramAvailable;
    const classified = classifyCommit(
      raw, this.variables, this.seedValue, this.numericOnly, asParam, this.arithmeticOnly,
    );
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

  /** The P toggle rides any input that would declare a new variable — an
   * explicit `name = value`, or a fresh name with no dropdown match. */
  private updateParamAvailability(): void {
    this.paramAvailable = !this.numericOnly && !this.arithmeticOnly
      && declaredVariableName(this.input.value.trim(), this.variables, this.seedValue) !== null;
    this.renderParamButton();
  }

  private renderParamButton(): void {
    this.paramBtn.classList.toggle('hidden', !this.paramAvailable);
    const active = this.paramMode;
    this.paramBtn.classList.toggle('bg-primary/20', active);
    this.paramBtn.classList.toggle('text-primary', active);
    this.paramBtn.classList.toggle('border-primary/40', active);
    this.paramBtn.classList.toggle('text-base-content/40', !active);
    this.paramBtn.classList.toggle('border-base-content/20', !active);
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
      this.applyVariableName(this.filteredVars[this.selectedIndex].name);
      this.userIsTyping = true;
      this.filterAndRender();
    }
  }

  private filterAndRender(preserveSelection = false): void {
    const prevIndex = this.selectedIndex;
    const query = this.userIsTyping && !this.numericOnly && !this.arithmeticOnly
      ? trailingIdentifier(this.input.value)
      : null;
    if (!query) {
      this.filteredVars = [];
      this.selectedIndex = -1;
      this.renderDropdown();
      return;
    }
    this.filteredVars = filterSuggestions(query, this.variables, this.input.value, this.seedValue);
    this.selectedIndex = preserveSelection && prevIndex >= 0 && prevIndex < this.filteredVars.length
      ? prevIndex
      : this.filteredVars.length > 0 ? 0 : -1;
    this.renderDropdown();
  }

  private applyVariableName(name: string): void {
    this.input.value = applyVariableName(this.input.value, name);
  }

  private renderDropdown(): void {
    if (this.filteredVars.length === 0) {
      this.dropdown.classList.add('hidden');
      return;
    }
    this.dropdown.classList.remove('hidden');
    this.dropdown.innerHTML = this.filteredVars
      .map((v, i) => suggestionItemHtml(v, i, i === this.selectedIndex))
      .join('');

    this.dropdown.querySelectorAll('[data-idx]').forEach((item) => {
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const idx = parseInt((item as HTMLElement).dataset.idx!, 10);
        this.applyVariableName(this.filteredVars[idx].name);
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
}
