/**
 * The expression-transparency row under the modify dialog: the synthesized
 * selector args, editable in place (`fillet(1, ` … `)`), with verified
 * alternatives in a dropdown. The host feeds the synthesized args and the
 * static prefix/suffix; the row owns its DOM, the menu's click-away, and the
 * input-width fitting.
 */
export class ExpressionRow {
  /** Enter pressed inside the args input — the host applies. */
  onSubmit?: () => void;

  private readonly row: HTMLDivElement;
  private readonly prefix: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly suffix: HTMLElement;
  private readonly altBtn: HTMLButtonElement;
  private readonly altMenu: HTMLDivElement;
  private synthesized: string | null = null;
  private alternatives: string[] = [];

  constructor(host: HTMLElement) {
    this.row = document.createElement('div');
    this.row.dataset.role = 'expr-row';
    // max-sm:hidden: the code-transparency row is desktop-only — on the mobile
    // bottom sheet it would eat scarce vertical space (matches the statement
    // preview in PanelShell).
    this.row.className = 'hidden max-sm:hidden relative items-center bg-base-100 border border-base-300 rounded-lg pl-2.5 pr-1 py-1.5 text-xs shadow-md';
    this.row.innerHTML = `
      <span data-role="expr-prefix" class="font-mono text-base-content/50 select-none whitespace-pre"></span>
      <input data-role="expr" type="text" spellcheck="false" autocomplete="off"
        class="font-mono max-w-[320px] bg-transparent text-base-content outline-none" />
      <span data-role="expr-suffix" class="font-mono text-base-content/50 select-none whitespace-pre">)</span>
      <button data-role="alts" title="Alternative selectors"
        class="hidden text-base-content/50 hover:text-base-content px-1 cursor-pointer transition-colors">▾</button>
      <div data-role="alts-menu"
        class="hidden absolute top-full right-0 mt-1 z-[1000] min-w-full bg-base-100 border border-base-300 rounded-lg shadow-lg py-1"></div>
    `;
    host.appendChild(this.row);
    this.prefix = this.row.querySelector('[data-role="expr-prefix"]')!;
    this.input = this.row.querySelector('[data-role="expr"]')!;
    this.suffix = this.row.querySelector('[data-role="expr-suffix"]')!;
    this.altBtn = this.row.querySelector('[data-role="alts"]')!;
    this.altMenu = this.row.querySelector('[data-role="alts-menu"]')!;

    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.onSubmit?.();
      }
      e.stopPropagation();
    });
    this.input.addEventListener('input', () => this.syncInputWidth());
    this.altBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.altMenu.classList.toggle('hidden');
    });
    document.addEventListener('click', (e) => {
      if (!this.altMenu.classList.contains('hidden')
        && !this.altMenu.contains(e.target as Node) && e.target !== this.altBtn) {
        this.altMenu.classList.add('hidden');
      }
    });
  }

  /** The args input's focused element (the host's Enter-to-apply exempts it). */
  get inputElement(): HTMLInputElement {
    return this.input;
  }

  /** The last synthesized (or seeded) args — the override baseline. */
  get synthesizedArgs(): string | null {
    return this.synthesized;
  }

  /** The current (possibly hand-edited) args text. */
  get value(): string {
    return this.input.value.trim();
  }

  /** Show the row with fresh args and their verified alternatives. */
  show(args: string, alternatives: string[]): void {
    this.synthesized = args;
    this.alternatives = alternatives;
    this.input.value = args;
    this.syncInputWidth();
    this.renderAlternatives();
    this.row.classList.remove('hidden');
    this.row.classList.add('flex');
  }

  hide(): void {
    this.row.classList.add('hidden');
    this.row.classList.remove('flex');
    this.altMenu.classList.add('hidden');
    this.synthesized = null;
    this.alternatives = [];
    this.input.value = '';
    this.syncInputWidth();
  }

  setPrefix(text: string): void {
    this.prefix.textContent = text;
  }

  setSuffix(text: string): void {
    this.suffix.textContent = text;
  }

  /** Close the alternatives menu; true when it was open (Escape handling). */
  closeMenuIfOpen(): boolean {
    if (this.altMenu.classList.contains('hidden')) {
      return false;
    }
    this.altMenu.classList.add('hidden');
    return true;
  }

  private renderAlternatives(): void {
    if (this.alternatives.length === 0) {
      this.altBtn.classList.add('hidden');
      this.altMenu.classList.add('hidden');
      return;
    }
    this.altBtn.classList.remove('hidden');
    this.altMenu.replaceChildren(...this.alternatives.map(args => {
      const item = document.createElement('button');
      item.className = 'block w-full text-left px-3 py-1.5 font-mono text-[11px] hover:bg-base-200 cursor-pointer whitespace-nowrap';
      item.textContent = args;
      item.addEventListener('click', () => {
        this.input.value = args;
        this.syncInputWidth();
        this.altMenu.classList.add('hidden');
      });
      return item;
    }));
  }

  /**
   * Fit the args input to its text so the static `)` suffix sits flush
   * against it (the font is monospace, so `ch` measures exactly); the +2px
   * keeps the caret visible at the end. `max-w-[320px]` still caps growth.
   */
  private syncInputWidth(): void {
    this.input.style.width = `calc(${Math.max(this.input.value.length, 1)}ch + 2px)`;
  }
}
