import { applySketchFillet, SketchApplyEntity } from '../api';
import { ExpressionRow } from './modify-pick/expression-row';
import { viewportChrome } from '../ui/viewport-chrome';

const PREVIEW_DEBOUNCE_MS = 250;

/**
 * The 2D fillet dialog: armed from the sketch toolbar, it reads the hover
 * handler's selected edges, previews the synthesized statement through
 * `/api/apply-feature` (sketch branch), and applies it — writing
 * `fillet(4, r.edge('top'), l)` into the sketch body. The expression row is
 * editable (expression transparency) with verified alternatives.
 */
export class SketchFilletService {
  /**
   * Fired on enter/exit. The dialog docks in the sketch dialog's spot, so
   * main.ts wires this (via the sketch toolbar service) to suspend the sketch
   * dialog while this one is open and restore it after.
   */
  onVisibilityChange?: (visible: boolean) => void;

  private readonly panel: HTMLDivElement;
  private readonly valueInput: HTMLInputElement;
  private readonly hint: HTMLDivElement;
  private readonly errorLine: HTMLDivElement;
  private readonly applyBtn: HTMLButtonElement;
  private readonly expression: ExpressionRow;

  private active = false;
  private previewTimer: number | null = null;
  private previewAbort: AbortController | null = null;
  private applying = false;

  constructor(
    container: HTMLElement,
    private getSelection: () => string[],
    private onDone: () => void,
  ) {
    this.panel = document.createElement('div');
    this.panel.id = 'fluidcad-sketch-fillet-panel';
    // top-[196px] right-4 matches the 3D dialogs (ModifyPanel and the
    // create-feature dialogs): just below the viewport gizmo, in the spot the
    // settings/fit-to-view button stack vacates while a dialog is open.
    this.panel.className = 'hidden absolute top-[196px] right-4 z-[999] pointer-events-auto';
    this.panel.innerHTML = `
      <div data-role="column" class="flex flex-col items-end gap-1.5">
        <div class="flex flex-col items-stretch gap-3.5 w-60 max-h-[calc(100vh-260px)] overflow-y-auto bg-base-100 border border-base-300 text-base-content rounded-lg px-4 py-4 text-xs select-none shadow-md">
          <div class="flex items-center gap-2.5">
            <span class="font-medium text-sm">Fillet</span>
          </div>
          <div data-role="hint" class="text-base-content/50">Pick sketch edges to fillet</div>
          <label class="flex flex-col gap-1.5">
            <span class="text-base-content/70">Radius</span>
            <input data-role="value" type="number" min="0" step="0.5" value="2"
              class="input input-sm input-bordered w-full font-mono text-xs" />
          </label>
          <div class="flex items-center gap-2 pt-1">
            <button data-role="apply" class="btn btn-primary btn-sm flex-1" disabled>Apply</button>
            <button data-role="cancel" class="btn btn-ghost btn-sm">Cancel</button>
          </div>
        </div>
      </div>
    `;
    container.appendChild(this.panel);

    this.valueInput = this.panel.querySelector('[data-role="value"]')!;
    this.hint = this.panel.querySelector('[data-role="hint"]')!;
    this.applyBtn = this.panel.querySelector('[data-role="apply"]')!;

    // The expression row and the error message dock under the dialog body,
    // matching the 3D dialogs (see ModifyPanel).
    const column = this.panel.querySelector<HTMLElement>('[data-role="column"]')!;
    this.expression = new ExpressionRow(column);
    this.errorLine = document.createElement('div');
    this.errorLine.className = 'hidden max-w-[380px] bg-error text-error-content rounded-lg px-3 py-2 text-xs leading-snug shadow-md';
    column.appendChild(this.errorLine);
    this.expression.setSuffix(')');
    this.expression.onSubmit = () => this.apply();

    this.valueInput.addEventListener('input', () => this.schedulePreview());
    this.valueInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.apply();
      }
      e.stopPropagation();
    });
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
      this.schedulePreview();
    }
  }

  private entities(): SketchApplyEntity[] {
    return this.getSelection().map(shapeId => ({ shapeId }));
  }

  private value(): number {
    const parsed = Number(this.valueInput.value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
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
    const entities = this.entities();
    const value = this.value();
    this.previewAbort?.abort();

    if (entities.length === 0 || value <= 0) {
      this.expression.hide();
      this.applyBtn.disabled = true;
      this.setHint(entities.length === 0
        ? 'Pick sketch edges to fillet'
        : 'Enter a positive radius');
      this.setError(null);
      return;
    }

    const abort = new AbortController();
    this.previewAbort = abort;
    try {
      const result = await applySketchFillet(value, entities, { preview: true, signal: abort.signal });
      if (abort.signal.aborted || !this.active) {
        return;
      }
      if (result.success && result.args !== undefined) {
        this.setHint(null);
        this.setError(null);
        this.expression.setPrefix(`fillet(${value}, `);
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
    if (this.applying || !this.active) {
      return;
    }
    const entities = this.entities();
    const value = this.value();
    if (entities.length === 0 || value <= 0) {
      return;
    }

    const edited = this.expression.value;
    const synthesized = this.expression.synthesizedArgs;
    const selectorOverride = edited !== '' && synthesized !== null && edited !== synthesized
      ? edited
      : undefined;

    this.applying = true;
    this.applyBtn.disabled = true;
    try {
      const result = await applySketchFillet(value, entities, { selectorOverride });
      if (result.success) {
        this.onDone();
      } else {
        this.setError(result.reason ?? 'Could not apply the fillet');
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
