import { applySketchFillet, SketchApplyEntity } from '../api';
import { ExpressionRow } from './modify-pick/expression-row';

const PREVIEW_DEBOUNCE_MS = 250;

/**
 * The 2D fillet dialog: armed from the sketch toolbar, it reads the hover
 * handler's selected edges, previews the synthesized statement through
 * `/api/apply-feature` (sketch branch), and applies it — writing
 * `fillet(4, r.edge('top'), l)` into the sketch body. The expression row is
 * editable (expression transparency) with verified alternatives.
 */
export class SketchFilletService {
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
    this.panel.className = 'hidden absolute bottom-6 left-1/2 -translate-x-1/2 z-[150] '
      + 'flex flex-col gap-2 panel-bg border border-base-content/10 rounded-lg shadow-[0_4px_12px_rgba(0,0,0,0.4)] p-3 min-w-[300px]';
    this.panel.innerHTML = `
      <div class="flex items-center gap-2">
        <span class="text-sm font-medium text-base-content">Fillet</span>
        <div data-role="hint" class="text-xs text-base-content/50">Pick sketch edges to fillet</div>
      </div>
      <div class="flex items-center gap-2">
        <label class="text-xs text-base-content/70">Radius</label>
        <input data-role="value" type="number" min="0" step="0.5" value="2"
          class="input input-sm input-bordered w-24 font-mono text-xs" />
        <button data-role="apply" class="btn btn-sm btn-primary ml-auto" disabled>Apply</button>
        <button data-role="cancel" class="btn btn-sm btn-ghost">Cancel</button>
      </div>
      <div data-role="expr-host"></div>
      <div data-role="error" class="hidden text-xs text-error"></div>
    `;
    container.appendChild(this.panel);

    this.valueInput = this.panel.querySelector('[data-role="value"]')!;
    this.hint = this.panel.querySelector('[data-role="hint"]')!;
    this.errorLine = this.panel.querySelector('[data-role="error"]')!;
    this.applyBtn = this.panel.querySelector('[data-role="apply"]')!;
    this.expression = new ExpressionRow(this.panel.querySelector('[data-role="expr-host"]')!);
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
    this.active = true;
    this.panel.classList.remove('hidden');
    this.schedulePreview();
  }

  exit(): void {
    this.active = false;
    this.panel.classList.add('hidden');
    this.cancelPreview();
    this.expression.hide();
    this.setError(null);
    this.applyBtn.disabled = true;
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
      this.hint.textContent = entities.length === 0
        ? 'Pick sketch edges to fillet'
        : 'Enter a positive radius';
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
        this.hint.textContent = '';
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
