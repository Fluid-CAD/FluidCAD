const CLOSE_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

export class ExportDialog {
  private overlay: HTMLDivElement;
  private formatSelect: HTMLSelectElement;
  private stepSection: HTMLDivElement;
  private stlSection: HTMLDivElement;
  private includeColorsCheckbox: HTMLInputElement;
  private resolutionSelect: HTMLSelectElement;
  private customSection: HTMLDivElement;
  private angularInput: HTMLInputElement;
  private linearInput: HTMLInputElement;
  private exportBtn: HTMLButtonElement;
  private statusEl: HTMLDivElement;
  private shapeIds: string[] = [];

  constructor(container: HTMLElement) {
    this.overlay = document.createElement('div');
    this.overlay.className = 'fixed inset-0 z-[300] bg-black/50 flex items-center justify-center hidden';
    this.overlay.innerHTML = this.buildHTML();
    container.appendChild(this.overlay);

    this.formatSelect = this.overlay.querySelector('[data-ref="format"]')!;
    this.stepSection = this.overlay.querySelector('[data-ref="step-section"]')!;
    this.stlSection = this.overlay.querySelector('[data-ref="stl-section"]')!;
    this.includeColorsCheckbox = this.overlay.querySelector('[data-ref="include-colors"]')!;
    this.resolutionSelect = this.overlay.querySelector('[data-ref="resolution"]')!;
    this.customSection = this.overlay.querySelector('[data-ref="custom-section"]')!;
    this.angularInput = this.overlay.querySelector('[data-ref="angular"]')!;
    this.linearInput = this.overlay.querySelector('[data-ref="linear"]')!;
    this.exportBtn = this.overlay.querySelector('[data-ref="export-btn"]')!;
    this.statusEl = this.overlay.querySelector('[data-ref="status"]')!;

    this.bindEvents();
  }

  show(shapeIds: string[]): void {
    this.shapeIds = shapeIds;
    this.statusEl.classList.add('hidden');
    this.exportBtn.disabled = false;
    this.overlay.classList.remove('hidden');
  }

  hide(): void {
    this.overlay.classList.add('hidden');
  }

  private buildHTML(): string {
    return `
      <div class="w-[380px] glass-dark border border-white/10 rounded-lg p-5 shadow-[0_4px_24px_rgba(0,0,0,0.5)]">
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-sm font-medium text-base-content/90">Export</h3>
          <button data-ref="close-btn" class="btn btn-ghost btn-square btn-xs text-base-content/60">
            <span class="[&>svg]:size-4">${CLOSE_SVG}</span>
          </button>
        </div>

        <div class="flex flex-col gap-3">
          <div>
            <label class="text-xs text-base-content/60 mb-1 block">Format</label>
            <select data-ref="format" class="select select-sm select-bordered w-full">
              <option value="step">STEP (.step)</option>
              <option value="stl">STL (.stl)</option>
            </select>
          </div>

          <div data-ref="step-section">
            <label class="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" data-ref="include-colors" class="checkbox checkbox-sm checkbox-primary" checked />
              <span class="text-xs text-base-content/70">Include colors</span>
            </label>
          </div>

          <div data-ref="stl-section" class="hidden flex flex-col gap-3">
            <div>
              <label class="text-xs text-base-content/60 mb-1 block">Resolution</label>
              <select data-ref="resolution" class="select select-sm select-bordered w-full">
                <option value="coarse">Coarse</option>
                <option value="medium" selected>Medium</option>
                <option value="fine">Fine</option>
                <option value="custom">Custom</option>
              </select>
            </div>

            <div data-ref="custom-section" class="hidden flex gap-2">
              <div class="flex-1">
                <label class="text-xs text-base-content/60 mb-1 block">Angular Deviation (deg)</label>
                <input data-ref="angular" type="number" class="input input-sm input-bordered w-full" value="17" min="1" max="90" step="1" />
              </div>
              <div class="flex-1">
                <label class="text-xs text-base-content/60 mb-1 block">Linear Deflection (mm)</label>
                <input data-ref="linear" type="number" class="input input-sm input-bordered w-full" value="0.3" min="0.001" max="10" step="0.01" />
              </div>
            </div>
          </div>
        </div>

        <div data-ref="status" class="hidden flex items-center gap-2 mt-3 text-xs text-base-content/60">
          <span class="loading loading-spinner loading-xs"></span>
          <span>Exporting...</span>
        </div>

        <div class="flex justify-end gap-2 mt-4">
          <button data-ref="cancel-btn" class="btn btn-ghost btn-sm">Cancel</button>
          <button data-ref="export-btn" class="btn btn-primary btn-sm">Export</button>
        </div>
      </div>
    `;
  }

  private bindEvents(): void {
    this.overlay.querySelector('[data-ref="close-btn"]')!.addEventListener('click', () => this.hide());
    this.overlay.querySelector('[data-ref="cancel-btn"]')!.addEventListener('click', () => this.hide());

    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) {
        this.hide();
      }
    });

    this.formatSelect.addEventListener('change', () => {
      const isStep = this.formatSelect.value === 'step';
      this.stepSection.classList.toggle('hidden', !isStep);
      this.stlSection.classList.toggle('hidden', isStep);
    });

    this.resolutionSelect.addEventListener('change', () => {
      this.customSection.classList.toggle('hidden', this.resolutionSelect.value !== 'custom');
    });

    this.exportBtn.addEventListener('click', () => this.onExport());
  }

  private async onExport(): Promise<void> {
    const format = this.formatSelect.value;
    const body: Record<string, any> = { format, shapeIds: this.shapeIds };

    if (format === 'step') {
      body.includeColors = this.includeColorsCheckbox.checked;
    } else {
      body.resolution = this.resolutionSelect.value;
      if (body.resolution === 'custom') {
        body.customAngularDeflectionDeg = parseFloat(this.angularInput.value);
        body.customLinearDeflection = parseFloat(this.linearInput.value);
      }
    }

    this.exportBtn.disabled = true;
    this.statusEl.classList.remove('hidden');
    this.statusEl.innerHTML = '<span class="loading loading-spinner loading-xs"></span><span>Exporting...</span>';

    try {
      const res = await fetch('/api/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Export failed');
      }

      const blob = await res.blob();
      const ext = format === 'step' ? '.step' : '.stl';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `export${ext}`;
      a.click();
      URL.revokeObjectURL(url);
      this.hide();
    } catch (err: any) {
      this.statusEl.innerHTML = `<span class="text-error text-xs">${err.message}</span>`;
    } finally {
      this.exportBtn.disabled = false;
    }
  }
}
