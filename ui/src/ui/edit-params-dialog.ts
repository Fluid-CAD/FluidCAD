import { updateInsertParams, type CatalogParamDef } from '../api';
import type { InstanceParamDef, InstanceParamValue } from '../types';
import { ICON_CLOSE } from './icons';
import { ParamForm } from './param-controls';

/**
 * The parts panel's "Edit parameters…" dialog: one `ParamForm` (the same
 * control rows the Insert carousel renders) seeded with the instance's or
 * occurrence's CURRENT values, committed as a merge into the `insert()`
 * statement's second argument. Only the labels the user actually changed
 * travel — untouched entries, expressions included, survive verbatim in
 * source. The re-render arriving over the WebSocket carries the updated
 * scene; the dialog just closes on success.
 */
export class EditParamsDialog {
  private overlay: HTMLDivElement;
  private form: ParamForm | null = null;
  private target: { filePath: string; line: number } | null = null;
  private applying = false;

  constructor(container: HTMLElement) {
    this.overlay = document.createElement('div');
    this.overlay.className = 'fixed inset-0 z-[300] bg-black/50 flex items-center justify-center hidden';
    this.overlay.innerHTML = `
      <div class="w-[380px] max-w-[92vw] max-h-[78vh] bg-base-100 border border-base-content/10 rounded-lg p-5 shadow-[0_4px_24px_rgba(0,0,0,0.5)] flex flex-col">
        <div class="flex items-center justify-between mb-1">
          <h3 data-ref="title" class="text-sm font-medium text-base-content/90"></h3>
          <button data-ref="close-btn" class="btn btn-ghost btn-square btn-xs text-base-content/60">
            <span class="[&>svg]:size-4">${ICON_CLOSE}</span>
          </button>
        </div>
        <div data-ref="subtitle" class="text-[10px] text-base-content/40 mb-3"></div>
        <div data-ref="form-host" class="overflow-y-auto flex-1"></div>
        <div data-ref="status" class="text-xs text-error min-h-4 mt-2"></div>
        <div class="flex items-center justify-end gap-2 pt-1">
          <button data-ref="cancel-btn" class="btn btn-ghost btn-sm">Cancel</button>
          <button data-ref="apply-btn" class="btn btn-primary btn-sm">Apply</button>
        </div>
      </div>
    `;
    container.appendChild(this.overlay);

    this.overlay.querySelector('[data-ref="close-btn"]')!.addEventListener('click', () => this.hide());
    this.overlay.querySelector('[data-ref="cancel-btn"]')!.addEventListener('click', () => this.hide());
    this.overlay.querySelector('[data-ref="apply-btn"]')!.addEventListener('click', () => void this.apply());
    this.overlay.addEventListener('mousedown', (e) => {
      if (e.target === this.overlay) {
        this.hide();
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.overlay.classList.contains('hidden')) {
        e.stopPropagation();
        this.hide();
      }
    }, true);
  }

  /**
   * Open for one insert statement. `defs` is the definition's parameter
   * interface (template `object.params` for instances, `occ.params` for
   * occurrences); `currentValues` the record's resolved values — the form
   * seeds from them, so the diff on Apply is exactly what the user changed.
   */
  show(opts: {
    title: string;
    subtitle: string;
    defs: InstanceParamDef[];
    currentValues: Record<string, InstanceParamValue>;
    filePath: string;
    line: number;
  }): void {
    this.target = { filePath: opts.filePath, line: opts.line };
    this.applying = false;
    this.overlay.querySelector('[data-ref="title"]')!.textContent = opts.title;
    this.overlay.querySelector('[data-ref="subtitle"]')!.textContent = opts.subtitle;
    this.setStatus('');

    const seeded: CatalogParamDef[] = opts.defs.map(def => ({
      ...def,
      currentValue: opts.currentValues[def.label] ?? def.currentValue,
    }));
    this.form = new ParamForm(seeded);
    const host = this.overlay.querySelector('[data-ref="form-host"]')!;
    host.innerHTML = '';
    host.appendChild(this.form.element);

    this.overlay.classList.remove('hidden');
  }

  hide(): void {
    this.overlay.classList.add('hidden');
    this.form = null;
    this.target = null;
  }

  private setStatus(text: string): void {
    this.overlay.querySelector('[data-ref="status"]')!.textContent = text;
  }

  private async apply(): Promise<void> {
    if (this.applying || !this.form || !this.target) {
      return;
    }
    const set = this.form.nonDefaultValues();
    if (Object.keys(set).length === 0) {
      this.hide();
      return;
    }
    this.applying = true;
    this.setStatus('');
    const result = await updateInsertParams(this.target.filePath, this.target.line, set);
    this.applying = false;
    if (!result.success) {
      this.setStatus(result.reason ?? 'Edit failed.');
      return;
    }
    this.hide();
  }
}
