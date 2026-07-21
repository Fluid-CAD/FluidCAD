import {
  applyVariableName, classifyCommit, declaredVariableName, filterSuggestions,
  suggestionItemHtml, trailingIdentifier, Suggestion, VariableInfo,
} from './expression-core';

/** A read field value: a plain number, or an expression (with an optional
 * `name = value` declaration to write alongside the statement). */
export type ExpressionFieldResult =
  | { value: number | string; newVariable?: { name: string; initializer: string } }
  | { error: string };

/**
 * Collect the declarations a dialog's field reads committed, deduplicated by
 * name; undefined when none — the apply payload omits the key entirely.
 */
export function collectNewVariables(
  reads: ({ newVariable?: { name: string; initializer: string } } | null | undefined)[],
): { name: string; initializer: string }[] | undefined {
  const seen = new Map<string, { name: string; initializer: string }>();
  for (const read of reads) {
    if (read?.newVariable && !seen.has(read.newVariable.name)) {
      seen.set(read.newVariable.name, read.newVariable);
    }
  }
  return seen.size > 0 ? [...seen.values()] : undefined;
}

/**
 * Enhances an existing dialog `<input>` with the sketcher's expression
 * behavior, in place: the input keeps its position and styling (it is only
 * flipped to type="text" so identifiers can be typed), and a suggestion
 * dropdown floats under it while the user is typing an identifier — plain
 * numbers never open it. Typing `myVar = 50` (or a fresh name over a numeric
 * seed) declares a new variable on commit, exactly like the sketcher input.
 *
 * The field owns the input's keyboard handling (arrows/Tab drive the
 * dropdown, Enter fills the selection or submits, Escape closes the dropdown
 * before it closes the dialog) — hosts wire `onSubmit` instead of their own
 * Enter listener.
 */
export class ExpressionField {
  /** Enter pressed with no suggestion selected — the dialogs apply. */
  onSubmit?: () => void;

  private variables: VariableInfo[] = [];
  private dropdown: HTMLDivElement;
  private paramBtn: HTMLButtonElement;
  private paramMode = false;
  private filtered: Suggestion[] = [];
  private selectedIndex = -1;
  private open = false;
  /** The last plain-number text the field held — a new variable's initializer. */
  private seedValue = '';
  private suppressFilter = false;
  private readonly onDocMousedown = (e: MouseEvent) => {
    if (e.target !== this.input && !this.dropdown.contains(e.target as Node)) {
      this.closeDropdown();
    }
  };
  private readonly onViewportChange = (e?: Event) => {
    // Scrolling the dropdown's own list (arrow-key scrollIntoView included)
    // must not close it — only the page/panel moving under it does.
    if (e && e.target instanceof Node && this.dropdown.contains(e.target)) {
      return;
    }
    this.closeDropdown();
  };
  private readonly onParamViewportChange = () => this.positionParamBtn();

  constructor(private input: HTMLInputElement) {
    input.type = 'text';
    input.autocomplete = 'off';
    input.spellcheck = false;
    this.seedValue = this.isPlainNumber(input.value) ? input.value.trim() : '';

    this.dropdown = document.createElement('div');
    this.dropdown.className =
      'fixed z-[1200] bg-base-100 border border-base-300 rounded-md shadow-lg max-h-[150px] overflow-y-auto hidden';
    document.body.appendChild(this.dropdown);

    // The "declare as param()" toggle rides the input's right edge while the
    // value is a `name = value` declaration; fixed like the dropdown, so the
    // dialog's own layout stays untouched.
    this.paramBtn = document.createElement('button');
    this.paramBtn.type = 'button';
    this.paramBtn.tabIndex = -1;
    this.paramBtn.textContent = 'P';
    this.paramBtn.title = 'Declare as parameter — param()';
    this.paramBtn.className =
      'fixed z-[1200] w-5 h-5 rounded text-xs font-mono font-semibold border cursor-pointer select-none hidden';
    document.body.appendChild(this.paramBtn);
    this.renderParamBtn();

    input.addEventListener('keydown', (e) => this.handleKeydown(e));
    input.addEventListener('input', () => this.handleInput());
    input.addEventListener('focus', () => this.updateParamBtn());
    input.addEventListener('blur', () => {
      this.closeDropdown();
      this.hideParamBtn();
    });
    this.dropdown.addEventListener('mousedown', (e) => {
      // Keep the input focused; item handlers fill the name themselves.
      e.preventDefault();
      e.stopPropagation();
    });
    this.paramBtn.addEventListener('mousedown', (e) => {
      // mousedown would blur the input; toggle without stealing focus.
      e.preventDefault();
      e.stopPropagation();
      this.paramMode = !this.paramMode;
      this.renderParamBtn();
    });
  }

  /** The variables offered by the dropdown (pushed by the owning service). */
  setVariables(variables: VariableInfo[]): void {
    this.variables = variables;
  }

  /** Programmatic value (defaults, edit-mode prefill); closes the dropdown. */
  setValue(value: number | string): void {
    const str = String(value);
    this.input.value = str;
    if (this.isPlainNumber(str)) {
      this.seedValue = str.trim();
    }
    this.closeDropdown();
    this.paramMode = false;
    this.hideParamBtn();
  }

  get element(): HTMLInputElement {
    return this.input;
  }

  /**
   * Read the field for an apply/preview: a plain number stays numeric (the
   * dialogs run their range checks), anything else commits as an expression.
   * A bare unknown identifier over a numeric seed — or a typed `name = value`
   * — also carries the declaration to write.
   */
  read(): ExpressionFieldResult {
    const raw = this.input.value.trim();
    if (!raw) {
      return { error: 'empty' };
    }
    if (this.isPlainNumber(raw)) {
      return { value: Number(raw) };
    }
    const asParam = this.paramMode
      && declaredVariableName(raw, this.variables, this.seedValue) !== null;
    const classified = classifyCommit(raw, this.variables, this.seedValue, false, asParam);
    if (classified.kind === 'error') {
      return { error: classified.message };
    }
    if (classified.kind === 'declare') {
      return {
        value: classified.name,
        newVariable: { name: classified.name, initializer: classified.initializer },
      };
    }
    return { value: classified.expression };
  }

  destroy(): void {
    this.closeDropdown();
    this.hideParamBtn();
    this.dropdown.remove();
    this.paramBtn.remove();
  }

  private isPlainNumber(raw: string): boolean {
    const trimmed = raw.trim();
    return trimmed !== '' && Number.isFinite(Number(trimmed));
  }

  private handleKeydown(e: KeyboardEvent): void {
    if (e.key === 'ArrowDown' && this.open) {
      e.preventDefault();
      e.stopPropagation();
      this.moveSelection(1);
      return;
    }
    if (e.key === 'ArrowUp' && this.open) {
      e.preventDefault();
      e.stopPropagation();
      this.moveSelection(-1);
      return;
    }
    if (e.key === 'Tab' && this.open && this.selectedIndex >= 0) {
      e.preventDefault();
      e.stopPropagation();
      this.fillName(this.filtered[this.selectedIndex].name, { keepOpen: true });
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      if (this.open && this.selectedIndex >= 0) {
        this.fillName(this.filtered[this.selectedIndex].name, { keepOpen: false });
        return;
      }
      this.onSubmit?.();
      return;
    }
    if (e.key === 'Escape' && this.open) {
      // Consumed here so the dialog's own Escape (exit) doesn't fire too.
      e.preventDefault();
      e.stopPropagation();
      this.closeDropdown();
      return;
    }
    if (e.key !== 'Escape') {
      // Dialog inputs never leak keystrokes to the global shortcuts.
      e.stopPropagation();
    }
  }

  private handleInput(): void {
    if (this.isPlainNumber(this.input.value)) {
      this.seedValue = this.input.value.trim();
    }
    this.updateParamBtn();
    if (this.suppressFilter) {
      this.suppressFilter = false;
      return;
    }
    this.filterAndRender();
  }

  private updateParamBtn(): void {
    const raw = this.input.value.trim();
    if (declaredVariableName(raw, this.variables, this.seedValue) === null) {
      this.hideParamBtn();
      return;
    }
    if (this.paramBtn.classList.contains('hidden')) {
      this.paramBtn.classList.remove('hidden');
      window.addEventListener('scroll', this.onParamViewportChange, true);
      window.addEventListener('resize', this.onParamViewportChange);
    }
    this.positionParamBtn();
  }

  private hideParamBtn(): void {
    if (this.paramBtn.classList.contains('hidden')) {
      return;
    }
    this.paramBtn.classList.add('hidden');
    window.removeEventListener('scroll', this.onParamViewportChange, true);
    window.removeEventListener('resize', this.onParamViewportChange);
  }

  private positionParamBtn(): void {
    const rect = this.input.getBoundingClientRect();
    this.paramBtn.style.left = `${rect.right - 22}px`;
    this.paramBtn.style.top = `${rect.top + (rect.height - 20) / 2}px`;
  }

  private renderParamBtn(): void {
    const active = this.paramMode;
    this.paramBtn.classList.toggle('bg-primary/20', active);
    this.paramBtn.classList.toggle('text-primary', active);
    this.paramBtn.classList.toggle('border-primary/40', active);
    this.paramBtn.classList.toggle('bg-base-100', !active);
    this.paramBtn.classList.toggle('text-base-content/40', !active);
    this.paramBtn.classList.toggle('border-base-content/20', !active);
  }

  private filterAndRender(): void {
    const query = trailingIdentifier(this.input.value);
    if (!query) {
      this.closeDropdown();
      return;
    }
    this.filtered = filterSuggestions(query, this.variables, this.input.value, this.seedValue);
    if (this.filtered.length === 0) {
      this.closeDropdown();
      return;
    }
    this.selectedIndex = 0;
    this.openDropdown();
    this.renderDropdown();
  }

  private fillName(name: string, opts: { keepOpen: boolean }): void {
    this.input.value = applyVariableName(this.input.value, name);
    // The hosts listen for 'input' to refresh their previews.
    this.suppressFilter = !opts.keepOpen;
    this.input.dispatchEvent(new Event('input', { bubbles: true }));
    if (opts.keepOpen) {
      this.filterAndRender();
    } else {
      this.closeDropdown();
    }
  }

  private moveSelection(delta: number): void {
    if (this.filtered.length === 0) {
      return;
    }
    this.selectedIndex += delta;
    if (this.selectedIndex < 0) {
      this.selectedIndex = this.filtered.length - 1;
    } else if (this.selectedIndex >= this.filtered.length) {
      this.selectedIndex = 0;
    }
    this.renderDropdown();
  }

  private openDropdown(): void {
    if (this.open) {
      this.position();
      return;
    }
    this.open = true;
    this.dropdown.classList.remove('hidden');
    this.position();
    document.addEventListener('mousedown', this.onDocMousedown, true);
    window.addEventListener('scroll', this.onViewportChange, true);
    window.addEventListener('resize', this.onViewportChange);
  }

  private closeDropdown(): void {
    if (!this.open) {
      return;
    }
    this.open = false;
    this.filtered = [];
    this.selectedIndex = -1;
    this.dropdown.classList.add('hidden');
    document.removeEventListener('mousedown', this.onDocMousedown, true);
    window.removeEventListener('scroll', this.onViewportChange, true);
    window.removeEventListener('resize', this.onViewportChange);
  }

  private position(): void {
    const rect = this.input.getBoundingClientRect();
    this.dropdown.style.left = `${rect.left}px`;
    this.dropdown.style.top = `${rect.bottom + 2}px`;
    this.dropdown.style.minWidth = `${Math.max(rect.width, 140)}px`;
  }

  private renderDropdown(): void {
    this.dropdown.innerHTML = this.filtered
      .map((v, i) => suggestionItemHtml(v, i, i === this.selectedIndex))
      .join('');
    this.dropdown.querySelectorAll('[data-idx]').forEach((item) => {
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const idx = parseInt((item as HTMLElement).dataset.idx!, 10);
        this.fillName(this.filtered[idx].name, { keepOpen: false });
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
