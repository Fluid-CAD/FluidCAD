import {
  applyVariableName, classifyCommit, declaredVariableName, filterSuggestions,
  resolveExpressionValue, suggestionItemHtml, trailingIdentifier, Suggestion, VariableInfo,
} from './expression-core';
import { isEditableTarget } from '../keyboard-bridge';

export type { VariableInfo };

/**
 * Parked at the bottom of the viewport, just left of the shape-properties
 * button. It used to follow the cursor, which made its own Δ and P buttons
 * impossible to click — they moved away as you reached for them — and made
 * the numbers jitter while being read. The locked-point marker in the scene
 * is what ties it back to where the geometry will land.
 */
const DOCK = 'absolute bottom-6 right-[72px] z-[1000] pointer-events-auto';

/**
 * Keys that never open the pill: Space cycles the polyline mode, and the
 * modifiers drive ortho/tangent overrides. Every other printable character
 * opens it — coordinates are expressions, so a variable name has to be
 * typeable straight in, not just digits.
 */
const NON_TRIGGER_KEYS = new Set([' ', 'Shift', 'Control', 'Meta', 'Alt']);

const TIP_STYLE_ID = 'fluidcad-point-tip-style';

/**
 * Narrow the chip's tooltips so they wrap instead of clipping. A daisyUI
 * tooltip is centred on its button via `translateX(-50%)` and capped at
 * 20rem, which overflows the viewport from a chip docked this close to the
 * right edge.
 *
 * Done with a stylesheet rather than Tailwind's `before:` variant: that
 * variant sets `--tw-content: ""`, which would overwrite daisyUI's
 * `--tw-content: attr(data-tip)` and leave the tooltip blank.
 */
function ensureTipStyle(): void {
  if (document.getElementById(TIP_STYLE_ID)) {
    return;
  }
  const style = document.createElement('style');
  style.id = TIP_STYLE_ID;
  style.textContent = '.point-tip[data-tip]::before { max-width: 10rem; }';
  document.head.appendChild(style);
}

export type NewVariable = { name: string; initializer: string };

export type PointCommit = {
  /** Resolved sketch-space position, for previews. */
  value: [number, number];
  /** Per-axis source expression — a plain number unless the user typed one. */
  xExpr: string;
  yExpr: string;
  /** Declarations this commit introduced (0–2). */
  newVariables: NewVariable[];
  /** Whether any axis was typed rather than taken from the cursor. */
  typed: boolean;
  /**
   * Set in relative mode: the offset the user entered. Takes precedence over
   * `xExpr`/`yExpr`, which still carry the resolved absolute position.
   */
  relative?: { dx: string; dy: string };
};

export type PointInputOptions = {
  /** Live snapped position under the cursor, in sketch coordinates. */
  value: [number, number];
  variables: VariableInfo[];
  onCommit: (result: PointCommit) => void;
  /**
   * The relative-mode reference — the kernel's current pen position. Omitted
   * (or null) hides the Δ toggle.
   */
  origin?: [number, number] | null;
  /** Numbers only: no variables, no declarations, no param toggle. */
  numericOnly?: boolean;
  /** Open showing offsets from `origin` rather than absolute coordinates. */
  relative?: boolean;
  /**
   * Focus the X field straight away. For an explicit "edit this point"
   * gesture; the drawing tools leave it unfocused so the pill reads as a
   * live readout and tool shortcuts keep working until the user types.
   */
  autoFocus?: boolean;
};

type AxisId = 'x' | 'y';

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * One coordinate field. `locked` holds the committed expression once the axis
 * is pinned; until then the field mirrors the cursor.
 */
class Axis {
  input!: HTMLInputElement;
  labelEl!: HTMLSpanElement;
  seedValue = '';
  userIsTyping = false;
  locked: string | null = null;
  lockedValue: number | null = null;
  newVariable: NewVariable | null = null;

  reset(): void {
    this.seedValue = '';
    this.userIsTyping = false;
    this.locked = null;
    this.lockedValue = null;
    this.newVariable = null;
    this.input.value = '';
  }

  get isPinned(): boolean {
    return this.locked !== null;
  }
}

/**
 * The sketcher's coordinate pill: a live X/Y readout that becomes a two-field
 * expression input as soon as the user types. Sibling of `ExpressionInput` —
 * both are built on `expression-core`, but this one owns two fields and the
 * axis-lock state, so it cannot simply wrap two of those (that class claims
 * Tab for autocomplete and stops propagation on every non-Escape key).
 */
export class PointInput {
  private el: HTMLDivElement;
  private wrapperEl: HTMLDivElement;
  private dropdown: HTMLDivElement;
  private errorEl: HTMLDivElement;
  private paramBtn: HTMLButtonElement;
  private relBtn: HTMLButtonElement;
  private relWrap: HTMLSpanElement;
  private paramWrap: HTMLSpanElement;

  private axes: Record<AxisId, Axis> = { x: new Axis(), y: new Axis() };
  private activeField: AxisId | null = null;
  private relative = false;
  private origin: [number, number] | null = null;
  private paramMode = false;
  private paramAvailable = false;
  private variables: VariableInfo[] = [];
  private filteredVars: Suggestion[] = [];
  private selectedIndex = -1;
  private live: [number, number] = [0, 0];
  private visible = false;
  private numericOnly = false;
  private errorVisible = false;
  private onCommit: ((result: PointCommit) => void) | null = null;

  onSpaceOverride: (() => void) | null = null;
  /** Reports a Δ click so the host can keep the mode across tool changes. */
  onRelativeToggle: ((relative: boolean) => void) | null = null;

  constructor(container: HTMLElement) {
    ensureTipStyle();
    this.el = document.createElement('div');
    this.el.className = `${DOCK} hidden`;
    // The chip is pinned to the bottom of the viewport, so the dropdown and
    // the error stack *above* it: laid out below they would grow downward off
    // screen, and with the bottom edge anchored they would shove the fields
    // upward every time a suggestion appeared.
    this.el.innerHTML = `
      <div class="mb-1 bg-red-500/90 text-white text-xs rounded-md px-2 py-1 shadow-lg hidden point-error"></div>
      <div class="mb-1 panel-bg border border-base-content/10 rounded-md shadow-lg max-h-[150px] overflow-y-auto hidden point-dropdown"></div>
      <div class="point-wrapper flex items-center gap-1.5 panel-bg border border-base-content/10 rounded-md px-2 py-1 shadow-lg">
        <span class="text-xs text-base-content/50 select-none point-label-x">X</span>
        <input type="text" class="bg-transparent border-none outline-none text-sm text-base-content w-20 font-mono point-input-x" />
        <span class="text-xs text-base-content/50 select-none point-label-y">Y</span>
        <input type="text" class="bg-transparent border-none outline-none text-sm text-base-content w-20 font-mono point-input-y" />
        <span class="tooltip tooltip-top point-tip inline-flex items-center shrink-0 hidden point-rel-wrap"
          data-tip="Relative to the current position">
          <button type="button" tabindex="-1"
            class="w-5 h-5 rounded text-xs font-mono font-semibold border cursor-pointer select-none point-rel-btn">Δ</button>
        </span>
        <span class="tooltip tooltip-top point-tip inline-flex items-center shrink-0 hidden point-param-wrap"
          data-tip="Declare as a parameter">
          <button type="button" tabindex="-1"
            class="w-5 h-5 rounded text-xs font-mono font-semibold border cursor-pointer select-none point-param-btn">P</button>
        </span>
      </div>
    `;

    container.appendChild(this.el);

    this.wrapperEl = this.el.querySelector('.point-wrapper')!;
    this.dropdown = this.el.querySelector('.point-dropdown')!;
    this.errorEl = this.el.querySelector('.point-error')!;
    this.paramBtn = this.el.querySelector('.point-param-btn')!;
    this.relBtn = this.el.querySelector('.point-rel-btn')!;
    this.relWrap = this.el.querySelector('.point-rel-wrap')!;
    this.paramWrap = this.el.querySelector('.point-param-wrap')!;

    this.axes.x.input = this.el.querySelector('.point-input-x')!;
    this.axes.x.labelEl = this.el.querySelector('.point-label-x')!;
    this.axes.y.input = this.el.querySelector('.point-input-y')!;
    this.axes.y.labelEl = this.el.querySelector('.point-label-y')!;

    // mousedown would blur the focused field; toggle without stealing focus.
    this.relBtn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.setRelative(!this.relative);
      this.onRelativeToggle?.(this.relative);
    });

    this.paramBtn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.paramMode = !this.paramMode;
      this.renderParamButton();
    });

    for (const id of ['x', 'y'] as AxisId[]) {
      this.bindAxis(id);
    }

    this.dropdown.addEventListener('mousedown', (e) => e.stopPropagation());
  }

  // ---------------------------------------------------------------- lifecycle

  show(opts: PointInputOptions): void {
    this.onCommit = opts.onCommit;
    this.variables = opts.variables;
    this.numericOnly = opts.numericOnly ?? false;
    this.origin = opts.origin ?? null;
    this.visible = true;
    this.activeField = null;
    this.relative = (opts.relative ?? false) && this.origin !== null;
    this.paramMode = false;
    this.selectedIndex = -1;
    this.axes.x.reset();
    this.axes.y.reset();
    this.el.classList.remove('hidden');
    this.updateValue(opts.value);
    this.clearInlineError();
    this.renderChrome();
    if (opts.autoFocus) {
      this.focusAxis('x');
    }
  }

  hide(): void {
    if (!this.visible) {
      return;
    }
    this.visible = false;
    this.activeField = null;
    this.el.classList.add('hidden');
    this.dropdown.classList.add('hidden');
    this.clearInlineError();
    this.onCommit = null;
    this.axes.x.input.blur();
    this.axes.y.input.blur();
  }

  get isVisible(): boolean {
    return this.visible;
  }

  /** True once a field has focus — the pill is taking keystrokes. */
  get isFocused(): boolean {
    return this.activeField !== null;
  }

  /** True when any axis is pinned or being typed. */
  get hasInput(): boolean {
    return this.axes.x.isPinned || this.axes.y.isPinned
      || this.axes.x.userIsTyping || this.axes.y.userIsTyping;
  }

  containsElement(el: EventTarget | null): boolean {
    return el instanceof Node && this.el.contains(el);
  }

  // ------------------------------------------------------------------ updates

  /** The live snapped cursor position; fills every field not pinned or typed. */
  updateValue(point: [number, number]): void {
    if (!this.visible) {
      return;
    }
    this.live = point;
    for (const id of ['x', 'y'] as AxisId[]) {
      const axis = this.axes[id];
      const shown = this.displayValue(id, point);
      axis.seedValue = String(shown);
      if (axis.isPinned || axis.userIsTyping) {
        continue;
      }
      axis.input.value = axis.seedValue;
      // A focused-but-untyped field tracks the cursor, so keep it selected —
      // the first keystroke then replaces the live value rather than appending.
      if (this.activeField === id) {
        axis.input.select();
      }
    }
    this.updateParamAvailability();
  }

  /**
   * The point's existing source expressions, seeded once the code read behind
   * a double-click resolves. Text only: each axis keeps the numeric seed it
   * opened with, so naming an axis declares the number rather than a copy of
   * the expression — matching `ExpressionInput.seedExpression`.
   */
  seedExpressions(x: string, y: string): void {
    if (!this.visible) {
      return;
    }
    for (const [id, text] of [['x', x], ['y', y]] as [AxisId, string][]) {
      const axis = this.axes[id];
      if (axis.userIsTyping || axis.isPinned) {
        continue;
      }
      axis.input.value = text;
    }
    this.updateParamAvailability();
  }

  /** The relative-mode reference — the kernel pen, refreshed every render. */
  setOrigin(origin: [number, number] | null): void {
    this.origin = origin;
    this.renderChrome();
  }

  // ------------------------------------------------------------------ trigger

  /**
   * A window-level keystroke arriving while the pill shows a live readout.
   * Digits, `-` and `.` open the X field seeded with that character; Tab opens
   * it with the live value selected. Returns true when the key was consumed.
   */
  handleTriggerKey(e: KeyboardEvent): boolean {
    if (!this.visible || this.activeField !== null || e.repeat) {
      return false;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) {
      return false;
    }
    // Another field already owns the keystroke (the text tool's panel is open
    // for the whole time its tool is armed).
    if (!this.containsElement(e.target) && isEditableTarget(e.target)) {
      return false;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      this.focusAxis('x');
      return true;
    }
    if (e.key.length !== 1 || NON_TRIGGER_KEYS.has(e.key)) {
      return false;
    }
    e.preventDefault();
    this.focusAxis('x');
    const axis = this.axes.x;
    axis.input.value = e.key;
    axis.userIsTyping = true;
    this.updateParamAvailability();
    this.filterAndRender();
    return true;
  }

  /**
   * Escape semantics: the first press drops typing and locks, returning the
   * pill to a live readout; a second press hides it. Returns true when the
   * press was consumed, so the tool only cancels itself once the pill is clean.
   */
  handleEscape(): boolean {
    if (!this.visible) {
      return false;
    }
    if (!this.hasInput && this.activeField === null) {
      return false;
    }
    this.axes.x.reset();
    this.axes.y.reset();
    this.activeField = null;
    this.axes.x.input.blur();
    this.axes.y.input.blur();
    this.clearInlineError();
    this.updateValue(this.live);
    this.renderChrome();
    return true;
  }

  // ------------------------------------------------------------------ resolve

  /** The pinned axes' resolved values, for drawing the guide lines. */
  getLocks(): { x: number | null; y: number | null } {
    const resolve = (id: AxisId): number | null => {
      const axis = this.axes[id];
      if (!axis.isPinned || axis.lockedValue === null) {
        return null;
      }
      if (!this.relative || !this.origin) {
        return axis.lockedValue;
      }
      return this.origin[id === 'x' ? 0 : 1] + axis.lockedValue;
    };
    return { x: resolve('x'), y: resolve('y') };
  }

  /**
   * The point a click should place: each pinned axis contributes its typed
   * expression, each free axis the live cursor value. Never rounds a typed
   * value — only the cursor-derived ones.
   */
  resolvePick(live: [number, number]): PointCommit {
    const { x, y } = this.axes;
    const newVariables = [x.newVariable, y.newVariable].filter(
      (v): v is NewVariable => v !== null,
    );
    const typed = x.isPinned || y.isPinned;

    if (this.relative && this.origin) {
      const dxVal = x.lockedValue ?? round2(live[0] - this.origin[0]);
      const dyVal = y.lockedValue ?? round2(live[1] - this.origin[1]);
      const dx = x.locked ?? String(dxVal);
      const dy = y.locked ?? String(dyVal);
      const value: [number, number] = [this.origin[0] + dxVal, this.origin[1] + dyVal];
      return {
        value,
        xExpr: String(round2(value[0])),
        yExpr: String(round2(value[1])),
        newVariables,
        typed,
        relative: { dx, dy },
      };
    }

    const xVal = x.lockedValue ?? round2(live[0]);
    const yVal = y.lockedValue ?? round2(live[1]);
    return {
      value: [xVal, yVal],
      xExpr: x.locked ?? String(round2(live[0])),
      yExpr: y.locked ?? String(round2(live[1])),
      newVariables,
      typed,
    };
  }

  // --------------------------------------------------------------------- wiring

  private bindAxis(id: AxisId): void {
    const axis = this.axes[id];

    axis.input.addEventListener('keydown', (e) => {
      // Escape and the bare modifiers stay on their way to the tool: the
      // former cancels, the latter drive ortho/tangent overrides that must
      // keep working while a coordinate is being typed.
      if (e.key !== 'Escape' && !NON_TRIGGER_KEYS.has(e.key)) {
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
        // An open dropdown contributes its highlighted suggestion first, then
        // Tab pins and advances. ExpressionInput's Tab only fills, but a
        // two-field pill needs it to move between axes — and filling without
        // advancing would leave Tab unable to ever pin a variable-named axis.
        if (this.selectedIndex >= 0 && this.selectedIndex < this.filteredVars.length) {
          this.applyVariableName(id, this.filteredVars[this.selectedIndex].name);
          axis.userIsTyping = true;
          this.selectedIndex = -1;
          this.renderDropdown();
        }
        if (this.pin(id)) {
          this.focusAxis(id === 'x' ? 'y' : 'x');
        }
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        if (this.selectedIndex >= 0 && this.selectedIndex < this.filteredVars.length) {
          this.applyVariableName(id, this.filteredVars[this.selectedIndex].name);
        }
        this.commitFrom(id);
        return;
      }
      if (e.key === ' ' && this.onSpaceOverride) {
        e.preventDefault();
        this.onSpaceOverride();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        this.handleEscape();
        return;
      }
    });

    axis.input.addEventListener('input', () => {
      // An emptied field resumes live updates from the cursor.
      axis.userIsTyping = axis.input.value.length > 0;
      if (!axis.userIsTyping) {
        axis.locked = null;
        axis.lockedValue = null;
        axis.newVariable = null;
      }
      if (this.errorVisible) {
        this.clearInlineError();
      }
      this.updateParamAvailability();
      this.filterAndRender();
      this.renderChrome();
    });

    axis.input.addEventListener('focus', () => {
      this.activeField = id;
      this.filterAndRender();
      this.renderChrome();
    });

    axis.input.addEventListener('mousedown', (e) => e.stopPropagation());
    axis.input.addEventListener('mouseup', (e) => e.stopPropagation());
    axis.input.addEventListener('click', (e) => e.stopPropagation());
  }

  private focusAxis(id: AxisId): void {
    this.activeField = id;
    const axis = this.axes[id];
    axis.input.focus();
    axis.input.select();
    this.renderChrome();
  }

  /**
   * Pin an axis to whatever it currently holds. Returns false (and shows the
   * error) when the text does not classify — the field keeps focus.
   */
  private pin(id: AxisId): boolean {
    const axis = this.axes[id];
    // An untouched field is only mirroring the cursor, so leave it free for
    // the mouse to keep driving. Only a typed (or already pinned) axis pins.
    if (!axis.userIsTyping && !axis.isPinned) {
      return true;
    }

    const raw = axis.input.value.trim();
    if (!raw) {
      return true;
    }

    const asParam = this.paramMode && this.paramAvailable;
    const classified = classifyCommit(raw, this.variables, axis.seedValue, this.numericOnly, asParam);
    if (classified.kind === 'error') {
      this.showInlineError(classified.message);
      return false;
    }

    if (classified.kind === 'declare') {
      axis.locked = classified.name;
      axis.newVariable = { name: classified.name, initializer: classified.initializer };
    } else {
      axis.locked = classified.expression;
      axis.newVariable = null;
    }
    axis.lockedValue = resolveExpressionValue(axis.locked, this.variables, axis.newVariable);
    axis.userIsTyping = false;
    this.selectedIndex = -1;
    this.renderDropdown();
    this.renderChrome();
    return true;
  }

  /**
   * Enter pins the active axis; once both are pinned the point is committed.
   * Pinning only one leaves the other on the cursor, so the user can slide
   * along the locked axis and click.
   */
  private commitFrom(id: AxisId): void {
    if (!this.pin(id)) {
      return;
    }

    // One axis pinned leaves the other on the cursor, so the user can slide
    // along the locked axis and click. Neither pinned — both fields left as
    // the live readout — means "place here", the same as a click.
    const other = id === 'x' ? 'y' : 'x';
    if (this.axes[id].isPinned && !this.axes[other].isPinned) {
      this.focusAxis(other);
      return;
    }

    const result = this.resolvePick(this.live);
    const handler = this.onCommit;
    this.hide();
    handler?.(result);
  }

  // ------------------------------------------------------------------ display

  /** What an axis shows for a live cursor position, honouring relative mode. */
  private displayValue(id: AxisId, point: [number, number]): number {
    const index = id === 'x' ? 0 : 1;
    if (this.relative && this.origin) {
      return round2(point[index] - this.origin[index]);
    }
    return round2(point[index]);
  }

  /**
   * Switch between absolute coordinates and offsets from the cursor. Driven
   * by the viewport's Δ button, since the pill itself follows the mouse.
   */
  setRelative(relative: boolean): void {
    if (this.relative === relative) {
      return;
    }
    this.relative = relative;
    if (!this.visible) {
      return;
    }
    // The pinned expressions were entered in the old frame of reference and no
    // longer mean what they say, so a mode flip starts the point over.
    this.axes.x.reset();
    this.axes.y.reset();
    this.updateValue(this.live);
    this.renderChrome();
  }

  private renderChrome(): void {
    const relLabel = this.relative && this.origin ? 'Δ' : '';
    this.axes.x.labelEl.textContent = `${relLabel}X`;
    this.axes.y.labelEl.textContent = `${relLabel}Y`;

    for (const id of ['x', 'y'] as AxisId[]) {
      const axis = this.axes[id];
      axis.input.classList.toggle('text-primary', axis.isPinned);
      axis.input.classList.toggle('font-semibold', axis.isPinned);
      axis.labelEl.classList.toggle('text-primary/70', axis.isPinned);
      axis.labelEl.classList.toggle('text-base-content/50', !axis.isPinned);
    }

    this.relWrap.classList.toggle('hidden', this.origin === null);
    this.relBtn.classList.toggle('bg-primary/20', this.relative);
    this.relBtn.classList.toggle('text-primary', this.relative);
    this.relBtn.classList.toggle('border-primary/40', this.relative);
    this.relBtn.classList.toggle('text-base-content/40', !this.relative);
    this.relBtn.classList.toggle('border-base-content/20', !this.relative);

    this.renderParamButton();
  }

  /** The P toggle rides whichever field would declare a new variable. */
  private updateParamAvailability(): void {
    const active = this.activeField ? this.axes[this.activeField] : null;
    this.paramAvailable = !this.numericOnly && active !== null
      && declaredVariableName(active.input.value.trim(), this.variables, active.seedValue) !== null;
    this.renderParamButton();
  }

  private renderParamButton(): void {
    this.paramWrap.classList.toggle('hidden', !this.paramAvailable);
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

  // ----------------------------------------------------------------- dropdown

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

  private applyVariableName(id: AxisId, name: string): void {
    const axis = this.axes[id];
    axis.input.value = applyVariableName(axis.input.value, name);
  }

  private filterAndRender(): void {
    const id = this.activeField;
    const axis = id ? this.axes[id] : null;
    const query = axis && axis.userIsTyping && !this.numericOnly
      ? trailingIdentifier(axis.input.value)
      : null;
    if (!query || !axis) {
      this.filteredVars = [];
      this.selectedIndex = -1;
      this.renderDropdown();
      return;
    }
    this.filteredVars = filterSuggestions(query, this.variables, axis.input.value, axis.seedValue);
    this.selectedIndex = this.filteredVars.length > 0 ? 0 : -1;
    this.renderDropdown();
  }

  private renderDropdown(): void {
    if (this.filteredVars.length === 0) {
      this.dropdown.classList.add('hidden');
      return;
    }
    this.dropdown.classList.remove('hidden');
    // Sit under whichever field is being typed into.
    const active = this.activeField ? this.axes[this.activeField].input : null;
    this.dropdown.style.marginLeft = active ? `${active.offsetLeft}px` : '0px';
    this.dropdown.innerHTML = this.filteredVars
      .map((v, i) => suggestionItemHtml(v, i, i === this.selectedIndex))
      .join('');

    this.dropdown.querySelectorAll('[data-idx]').forEach((item) => {
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const id = this.activeField;
        if (!id) {
          return;
        }
        const idx = parseInt((item as HTMLElement).dataset.idx!, 10);
        this.applyVariableName(id, this.filteredVars[idx].name);
        this.selectedIndex = -1;
        this.commitFrom(id);
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
