import { applySketchOp, SketchApplyEntity, SketchOpFeature } from '../api';
import { ExpressionRow } from './modify-pick/expression-row';
import { viewportChrome } from '../ui/viewport-chrome';

const PREVIEW_DEBOUNCE_MS = 250;

/** The per-operation dressing of the shared 2D op dialog. */
export type SketchOpConfig = {
  feature: SketchOpFeature;
  title: string;
  pickHint: string;
  /**
   * The numeric parameter row (fillet radius, offset distance); the booleans
   * have none. 'positive' forbids ≤0, 'nonzero' allows negative (offset).
   */
  value?: { label: string; defaultValue: string; sign: 'positive' | 'nonzero' };
  /**
   * Slot-addressed picking (subtract): the dialog carries Base and Tool rows,
   * picks fill the armed row, and switching rows freezes the current picks
   * into the row being left.
   */
  slotted?: boolean;
};

const SLOT_ROW_BASE = 'flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 cursor-pointer transition-colors';
const SLOT_ROW_ARMED = `${SLOT_ROW_BASE} border-primary/60 bg-primary/10`;
const SLOT_ROW_IDLE = `${SLOT_ROW_BASE} border-base-300 hover:border-base-content/30`;

/**
 * The shared 2D operation dialog (fillet, offset, fuse, subtract, common):
 * armed from the sketch toolbar, it reads the hover handler's selected edges,
 * previews the synthesized statement through `/api/apply-feature` (sketch
 * branch), and applies it — writing `fillet(4, r.edge('top'), l)` /
 * `offset(2, r.edge('top'))` / `subtract(r, c)` into the sketch body. The
 * expression row is editable (expression transparency) with verified
 * alternatives.
 */
export class SketchOpService {
  /**
   * Fired on enter/exit. The dialog docks in the sketch dialog's spot, so
   * main.ts wires this (via the sketch toolbar service) to suspend the sketch
   * dialog while this one is open and restore it after.
   */
  onVisibilityChange?: (visible: boolean) => void;

  private readonly panel: HTMLDivElement;
  private readonly valueInput: HTMLInputElement | null;
  private readonly hint: HTMLDivElement;
  private readonly errorLine: HTMLDivElement;
  private readonly applyBtn: HTMLButtonElement;
  private readonly expression: ExpressionRow;
  private readonly slotRows: { base: HTMLDivElement; tool: HTMLDivElement } | null;

  private active = false;
  private previewTimer: number | null = null;
  private previewAbort: AbortController | null = null;
  private applying = false;

  // Slotted picking state: the armed slot's entities ARE the live selection;
  // the other slot holds what was frozen when the user switched away.
  private armedSlot: 'base' | 'tool' = 'base';
  private frozen: { base: string[]; tool: string[] } = { base: [], tool: [] };

  constructor(
    container: HTMLElement,
    private readonly config: SketchOpConfig,
    private getSelection: () => string[],
    private clearSelection: () => void,
    private onDone: () => void,
  ) {
    this.panel = document.createElement('div');
    this.panel.id = `fluidcad-sketch-${config.feature}-panel`;
    // top-[196px] right-4 matches the 3D dialogs (ModifyPanel and the
    // create-feature dialogs): just below the viewport gizmo, in the spot the
    // settings/fit-to-view button stack vacates while a dialog is open.
    this.panel.className = 'hidden absolute top-[196px] right-4 z-[999] pointer-events-auto';
    const valueRow = config.value
      ? `
          <label class="flex flex-col gap-1.5">
            <span class="text-base-content/70">${config.value.label}</span>
            <input data-role="value" type="number" step="0.5" value="${config.value.defaultValue}"
              ${config.value.sign === 'positive' ? 'min="0"' : ''}
              class="input input-sm input-bordered w-full font-mono text-xs" />
          </label>`
      : '';
    const slotRows = config.slotted
      ? `
          <div class="flex flex-col gap-1.5">
            <div data-role="slot-base" class="${SLOT_ROW_ARMED}">
              <span class="text-base-content/70">Base</span>
              <span data-role="slot-base-count" class="font-mono text-base-content/50">pick edges</span>
            </div>
            <div data-role="slot-tool" class="${SLOT_ROW_IDLE}">
              <span class="text-base-content/70">Tool</span>
              <span data-role="slot-tool-count" class="font-mono text-base-content/50">pick edges</span>
            </div>
          </div>`
      : '';
    this.panel.innerHTML = `
      <div data-role="column" class="flex flex-col items-end gap-1.5">
        <div class="flex flex-col items-stretch gap-3.5 w-60 max-h-[calc(100vh-260px)] overflow-y-auto bg-base-100 border border-base-300 text-base-content rounded-lg px-4 py-4 text-xs select-none shadow-md">
          <div class="flex items-center gap-2.5">
            <span class="font-medium text-sm">${config.title}</span>
          </div>
          <div data-role="hint" class="text-base-content/50">${config.pickHint}</div>${slotRows}${valueRow}
          <div class="flex items-center gap-2 pt-1">
            <button data-role="apply" class="btn btn-primary btn-sm flex-1" disabled>Apply</button>
            <button data-role="cancel" class="btn btn-ghost btn-sm">Cancel</button>
          </div>
        </div>
      </div>
    `;
    container.appendChild(this.panel);

    this.valueInput = this.panel.querySelector('[data-role="value"]');
    this.hint = this.panel.querySelector('[data-role="hint"]')!;
    this.applyBtn = this.panel.querySelector('[data-role="apply"]')!;
    this.slotRows = config.slotted
      ? {
        base: this.panel.querySelector('[data-role="slot-base"]')!,
        tool: this.panel.querySelector('[data-role="slot-tool"]')!,
      }
      : null;

    // The expression row and the error message dock under the dialog body,
    // matching the 3D dialogs (see ModifyPanel).
    const column = this.panel.querySelector<HTMLElement>('[data-role="column"]')!;
    this.expression = new ExpressionRow(column);
    this.errorLine = document.createElement('div');
    this.errorLine.className = 'hidden max-w-[380px] bg-error text-error-content rounded-lg px-3 py-2 text-xs leading-snug shadow-md';
    column.appendChild(this.errorLine);

    this.expression.setSuffix(')');
    this.expression.onSubmit = () => this.apply();

    if (this.valueInput) {
      this.valueInput.addEventListener('input', () => this.schedulePreview());
      this.valueInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this.apply();
        }
        e.stopPropagation();
      });
    }
    if (this.slotRows) {
      this.slotRows.base.addEventListener('click', () => this.armSlot('base'));
      this.slotRows.tool.addEventListener('click', () => this.armSlot('tool'));
    }
    this.applyBtn.addEventListener('click', () => this.apply());
    this.panel.querySelector('[data-role="cancel"]')!.addEventListener('click', () => this.onDone());
  }

  get isActive(): boolean {
    return this.active;
  }

  enter(): void {
    if (this.active) {
      return;
    }
    this.active = true;
    this.armedSlot = 'base';
    this.frozen = { base: [], tool: [] };
    this.syncSlotRows();
    this.panel.classList.remove('hidden');
    viewportChrome.setDialogOpen(this.panel.id, true);
    this.onVisibilityChange?.(true);
    this.schedulePreview();
  }

  exit(): void {
    if (!this.active) {
      return;
    }
    this.active = false;
    this.panel.classList.add('hidden');
    viewportChrome.setDialogOpen(this.panel.id, false);
    this.cancelPreview();
    this.expression.hide();
    this.setError(null);
    this.applyBtn.disabled = true;
    this.onVisibilityChange?.(false);
  }

  /** The selected set or the scene changed — refresh the preview. */
  refresh(): void {
    if (this.active) {
      this.syncSlotRows();
      this.schedulePreview();
    }
  }

  /** Switch the armed slot, freezing the picks of the slot being left. */
  private armSlot(slot: 'base' | 'tool'): void {
    if (!this.slotRows || this.armedSlot === slot) {
      return;
    }
    this.frozen[this.armedSlot] = this.getSelection();
    this.armedSlot = slot;
    // The freeze keeps the leaving slot's picks; the arriving slot re-picks
    // from scratch (its previous content is discarded with the selection).
    this.frozen[slot] = [];
    this.clearSelection();
    this.syncSlotRows();
    this.schedulePreview();
  }

  /** The entities of one slot: live selection when armed, else the frozen set. */
  private slotIds(slot: 'base' | 'tool'): string[] {
    return this.armedSlot === slot ? this.getSelection() : this.frozen[slot];
  }

  private syncSlotRows(): void {
    if (!this.slotRows) {
      return;
    }
    for (const slot of ['base', 'tool'] as const) {
      const row = this.slotRows[slot];
      row.className = this.armedSlot === slot ? SLOT_ROW_ARMED : SLOT_ROW_IDLE;
      const count = this.slotIds(slot).length;
      const label = row.querySelector(`[data-role="slot-${slot}-count"]`)!;
      label.textContent = count === 0 ? 'pick edges' : `${count} edge${count === 1 ? '' : 's'}`;
    }
  }

  private toEntities(ids: string[]): SketchApplyEntity[] {
    return ids.map(shapeId => ({ shapeId }));
  }

  /** The dialog's numeric value; null for valueless ops, 0 when invalid. */
  private value(): number | null {
    if (!this.config.value || !this.valueInput) {
      return null;
    }
    const parsed = Number(this.valueInput.value);
    if (!Number.isFinite(parsed)) {
      return 0;
    }
    if (this.config.value.sign === 'positive' && parsed <= 0) {
      return 0;
    }
    return parsed;
  }

  /** What the current picks and value are missing, or null when previewable. */
  private incompleteReason(): string | null {
    if (this.config.slotted) {
      if (this.slotIds('base').length === 0) {
        return 'Pick the base geometry’s edges';
      }
      if (this.slotIds('tool').length === 0) {
        return 'Arm the Tool row and pick the geometry to subtract';
      }
    } else if (this.getSelection().length === 0) {
      return this.config.pickHint;
    }
    if (this.config.value && this.value() === 0) {
      return this.config.value.sign === 'positive'
        ? `Enter a positive ${this.config.value.label.toLowerCase()}`
        : `Enter a nonzero ${this.config.value.label.toLowerCase()}`;
    }
    return null;
  }

  private schedulePreview(): void {
    if (!this.active) {
      return;
    }
    if (this.previewTimer !== null) {
      window.clearTimeout(this.previewTimer);
    }
    this.previewTimer = window.setTimeout(() => {
      this.previewTimer = null;
      void this.runPreview();
    }, PREVIEW_DEBOUNCE_MS);
  }

  private cancelPreview(): void {
    if (this.previewTimer !== null) {
      window.clearTimeout(this.previewTimer);
      this.previewTimer = null;
    }
    this.previewAbort?.abort();
    this.previewAbort = null;
  }

  private async runPreview(): Promise<void> {
    this.previewAbort?.abort();

    const incomplete = this.incompleteReason();
    if (incomplete) {
      this.expression.hide();
      this.applyBtn.disabled = true;
      this.setHint(incomplete);
      this.setError(null);
      return;
    }

    const value = this.value();
    const entities = this.toEntities(this.config.slotted ? this.slotIds('base') : this.getSelection());
    const toolEntities = this.config.slotted ? this.toEntities(this.slotIds('tool')) : undefined;

    const abort = new AbortController();
    this.previewAbort = abort;
    try {
      const result = await applySketchOp(this.config.feature, value ?? undefined, entities, {
        toolEntities, preview: true, signal: abort.signal,
      });
      if (abort.signal.aborted || !this.active) {
        return;
      }
      if (result.success && result.args !== undefined) {
        this.setHint(null);
        this.setError(null);
        this.expression.setPrefix(value === null
          ? `${this.config.feature}(`
          : `${this.config.feature}(${value}, `);
        this.expression.show(result.args, result.alternatives ?? []);
        this.applyBtn.disabled = false;
      } else {
        this.expression.hide();
        this.applyBtn.disabled = true;
        this.setError(result.reason ?? 'Could not synthesize a selector for this selection');
      }
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        this.setError('Could not reach the FluidCAD server');
      }
    }
  }

  private async apply(): Promise<void> {
    if (this.applying || !this.active || this.incompleteReason() !== null) {
      return;
    }
    const value = this.value();
    const entities = this.toEntities(this.config.slotted ? this.slotIds('base') : this.getSelection());
    const toolEntities = this.config.slotted ? this.toEntities(this.slotIds('tool')) : undefined;

    const edited = this.expression.value;
    const synthesized = this.expression.synthesizedArgs;
    const selectorOverride = edited !== '' && synthesized !== null && edited !== synthesized
      ? edited
      : undefined;

    this.applying = true;
    this.applyBtn.disabled = true;
    try {
      const result = await applySketchOp(this.config.feature, value ?? undefined, entities, {
        toolEntities, selectorOverride,
      });
      if (result.success) {
        this.onDone();
      } else {
        this.setError(result.reason ?? `Could not apply the ${this.config.feature}`);
        this.applyBtn.disabled = false;
      }
    } finally {
      this.applying = false;
    }
  }

  private setHint(message: string | null): void {
    if (message) {
      this.hint.textContent = message;
      this.hint.classList.remove('hidden');
    } else {
      this.hint.textContent = '';
      this.hint.classList.add('hidden');
    }
  }

  private setError(message: string | null): void {
    if (message) {
      this.errorLine.textContent = message;
      this.errorLine.classList.remove('hidden');
    } else {
      this.errorLine.textContent = '';
      this.errorLine.classList.add('hidden');
    }
  }
}
