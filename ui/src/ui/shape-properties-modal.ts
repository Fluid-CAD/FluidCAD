const ICON_SCALE = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <line x1="8" y1="2" x2="8" y2="14"/>
  <line x1="5" y1="14" x2="11" y2="14"/>
  <line x1="2" y1="5" x2="14" y2="5"/>
  <path d="M2 5 L2 8 Q2 10 4 10 Q6 10 6 8 L6 5"/>
  <path d="M10 5 L10 8 Q10 10 12 10 Q14 10 14 8 L14 5"/>
</svg>`;

const STYLES = `
.spm-trigger {
  position: absolute;
  bottom: 24px;
  right: 24px;
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(30, 30, 30, 0.85);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  color: #999;
  cursor: pointer;
  z-index: 100;
  transition: background 0.15s, color 0.15s;
}

.spm-trigger:hover {
  background: rgba(50, 50, 50, 0.9);
  color: #e0e0e0;
}

.spm-trigger.active {
  background: rgba(74, 158, 255, 0.2);
  color: #4a9eff;
  border-color: rgba(74, 158, 255, 0.4);
}

.spm-panel {
  position: absolute;
  bottom: 68px;
  right: 24px;
  width: 300px;
  background: rgba(30, 30, 30, 0.95);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  padding: 16px;
  z-index: 200;
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.5);
  color: #d4d4d4;
  font-family: var(--vscode-font-family, system-ui, sans-serif);
  font-size: 13px;
  display: none;
}

.spm-panel.open {
  display: block;
}

.spm-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.spm-panel-title {
  font-size: 12px;
  font-weight: 600;
  color: #bbb;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.spm-panel-close {
  background: none;
  border: none;
  color: #666;
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
  padding: 0 2px;
  border-radius: 3px;
}

.spm-panel-close:hover {
  color: #ccc;
  background: rgba(255,255,255,0.08);
}

.spm-placeholder {
  color: #888;
  font-size: 12px;
  text-align: center;
  padding: 8px 0;
}

.spm-field {
  margin-bottom: 10px;
}

.spm-label {
  display: block;
  color: #888;
  margin-bottom: 4px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.spm-row {
  display: flex;
  gap: 8px;
}

.spm-row .spm-field {
  flex: 1;
}

.spm-select,
.spm-input {
  width: 100%;
  background: #252525;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 4px;
  color: #d4d4d4;
  font-size: 12px;
  padding: 4px 7px;
  box-sizing: border-box;
  outline: none;
}

.spm-select:focus,
.spm-input:focus {
  border-color: #4a9eff;
}

.spm-calculate {
  width: 100%;
  background: #4a9eff;
  color: #fff;
  border: none;
  border-radius: 4px;
  padding: 6px 0;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  margin-top: 2px;
}

.spm-calculate:hover {
  background: #5aabff;
}

.spm-calculate:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.spm-results {
  margin-top: 12px;
  border-top: 1px solid rgba(255, 255, 255, 0.07);
  padding-top: 10px;
  display: none;
}

.spm-results.visible {
  display: block;
}

.spm-result-row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  padding: 2px 0;
}

.spm-result-label {
  color: #888;
  font-size: 11px;
}

.spm-result-value {
  color: #e0e0e0;
  font-size: 12px;
  font-weight: 500;
}

.spm-error {
  color: #f48771;
  font-size: 11px;
  margin-top: 6px;
  display: none;
}

.spm-error.visible {
  display: block;
}
`;

type RawProps = { volumeMm3: number; surfaceAreaMm2: number; centroid: { x: number; y: number; z: number } };

export class ShapePropertiesModal {
  private btn: HTMLButtonElement;
  private panel: HTMLDivElement;
  private placeholderEl!: HTMLDivElement;
  private formEl!: HTMLDivElement;
  private selectEl!: HTMLSelectElement;
  private densityEl!: HTMLInputElement;
  private lengthUnitEl!: HTMLSelectElement;
  private massUnitEl!: HTMLSelectElement;
  private calcBtn!: HTMLButtonElement;
  private resultsEl!: HTMLDivElement;
  private errorEl!: HTMLDivElement;
  private volVal!: HTMLSpanElement;
  private areaVal!: HTMLSpanElement;
  private massVal!: HTMLSpanElement;

  private selectedShapeId: string | null = null;
  private rawProps: RawProps | null = null;

  constructor(container: HTMLElement) {
    if (!document.getElementById('spm-styles')) {
      const style = document.createElement('style');
      style.id = 'spm-styles';
      style.textContent = STYLES;
      document.head.appendChild(style);
    }

    this.btn = document.createElement('button');
    this.btn.className = 'spm-trigger';
    this.btn.title = 'Shape Properties';
    this.btn.innerHTML = ICON_SCALE;
    container.appendChild(this.btn);

    this.panel = document.createElement('div');
    this.panel.className = 'spm-panel';
    this.panel.innerHTML = this.buildHTML();
    container.appendChild(this.panel);

    this.bindRefs();
    this.bindEvents();
    this.loadMaterials();
  }

  private buildHTML(): string {
    return `
      <div class="spm-panel-header">
        <span class="spm-panel-title">Shape Properties</span>
        <button class="spm-panel-close" data-action="panel-close">×</button>
      </div>
      <div class="spm-placeholder" data-ref="placeholder">Select a shape to view its properties</div>
      <div data-ref="form" style="display:none">
        <div class="spm-field">
          <label class="spm-label">Material</label>
          <select class="spm-select" data-ref="material"></select>
        </div>
        <div class="spm-field">
          <label class="spm-label">Density (g/cm³)</label>
          <input type="number" class="spm-input" data-ref="density" step="0.01" min="0" />
        </div>
        <div class="spm-row">
          <div class="spm-field">
            <label class="spm-label">Length Unit</label>
            <select class="spm-select" data-ref="length-unit">
              <option value="mm">mm</option>
              <option value="inch">inch</option>
            </select>
          </div>
          <div class="spm-field">
            <label class="spm-label">Mass Unit</label>
            <select class="spm-select" data-ref="mass-unit">
              <option value="g">g</option>
              <option value="kg">kg</option>
              <option value="lbs">lbs</option>
            </select>
          </div>
        </div>
        <button class="spm-calculate" data-action="calculate">Calculate</button>
        <div class="spm-error" data-ref="error"></div>
      </div>
      <div class="spm-results" data-ref="results">
        <div class="spm-result-row">
          <span class="spm-result-label">Volume</span>
          <span class="spm-result-value" data-ref="vol">—</span>
        </div>
        <div class="spm-result-row">
          <span class="spm-result-label">Surface Area</span>
          <span class="spm-result-value" data-ref="area">—</span>
        </div>
        <div class="spm-result-row">
          <span class="spm-result-label">Mass</span>
          <span class="spm-result-value" data-ref="mass">—</span>
        </div>
      </div>
    `;
  }

  private bindRefs(): void {
    this.placeholderEl = this.panel.querySelector<HTMLDivElement>('[data-ref="placeholder"]')!;
    this.formEl = this.panel.querySelector<HTMLDivElement>('[data-ref="form"]')!;
    this.selectEl = this.panel.querySelector<HTMLSelectElement>('[data-ref="material"]')!;
    this.densityEl = this.panel.querySelector<HTMLInputElement>('[data-ref="density"]')!;
    this.lengthUnitEl = this.panel.querySelector<HTMLSelectElement>('[data-ref="length-unit"]')!;
    this.massUnitEl = this.panel.querySelector<HTMLSelectElement>('[data-ref="mass-unit"]')!;
    this.calcBtn = this.panel.querySelector<HTMLButtonElement>('[data-action="calculate"]')!;
    this.resultsEl = this.panel.querySelector<HTMLDivElement>('[data-ref="results"]')!;
    this.errorEl = this.panel.querySelector<HTMLDivElement>('[data-ref="error"]')!;
    this.volVal = this.panel.querySelector<HTMLSpanElement>('[data-ref="vol"]')!;
    this.areaVal = this.panel.querySelector<HTMLSpanElement>('[data-ref="area"]')!;
    this.massVal = this.panel.querySelector<HTMLSpanElement>('[data-ref="mass"]')!;
  }

  private bindEvents(): void {
    this.btn.addEventListener('click', () => this.toggle());

    this.panel.querySelector('[data-action="panel-close"]')!.addEventListener('click', () => this.close());

    this.selectEl.addEventListener('change', () => {
      const opt = this.selectEl.options[this.selectEl.selectedIndex];
      if (opt?.dataset.density) {
        this.densityEl.value = opt.dataset.density;
      }
    });

    this.calcBtn.addEventListener('click', () => this.calculate());
    this.lengthUnitEl.addEventListener('change', () => this.renderResults());
    this.massUnitEl.addEventListener('change', () => this.renderResults());
  }

  private toggle(): void {
    if (this.panel.classList.contains('open')) {
      this.close();
    } else {
      this.open();
    }
  }

  private open(): void {
    this.panel.classList.add('open');
    this.btn.classList.add('active');
  }

  private close(): void {
    this.panel.classList.remove('open');
    this.btn.classList.remove('active');
  }

  private async loadMaterials(): Promise<void> {
    try {
      const res = await fetch('/api/materials');
      if (!res.ok) {
        return;
      }
      const materials: { name: string; density: number }[] = await res.json();
      this.selectEl.innerHTML = '';
      for (const mat of materials) {
        const opt = document.createElement('option');
        opt.textContent = mat.name;
        opt.dataset.density = String(mat.density);
        this.selectEl.appendChild(opt);
      }
      const first = this.selectEl.options[0];
      if (first) {
        this.densityEl.value = first.dataset.density || '';
      }
    } catch {
      // silently ignore if materials endpoint not available
    }
  }

  private async calculate(): Promise<void> {
    if (!this.selectedShapeId) {
      return;
    }
    this.calcBtn.disabled = true;
    this.errorEl.classList.remove('visible');
    this.resultsEl.classList.remove('visible');

    try {
      const res = await fetch(`/api/shape-properties?shapeId=${encodeURIComponent(this.selectedShapeId)}`);
      if (res.status === 404) {
        this.showError('Shape not found. Try re-rendering the scene.');
        return;
      }
      if (!res.ok) {
        this.showError('Failed to calculate properties.');
        return;
      }
      this.rawProps = await res.json();
      this.renderResults();
    } catch {
      this.showError('Network error while fetching properties.');
    } finally {
      this.calcBtn.disabled = false;
    }
  }

  private renderResults(): void {
    if (!this.rawProps) {
      return;
    }

    const lengthUnit = this.lengthUnitEl.value;
    const massUnit = this.massUnitEl.value;
    const density = parseFloat(this.densityEl.value) || 0;

    let vol: string;
    let area: string;

    if (lengthUnit === 'inch') {
      vol = `${(this.rawProps.volumeMm3 / 16387.064).toFixed(4)} in³`;
      area = `${(this.rawProps.surfaceAreaMm2 / 645.16).toFixed(4)} in²`;
    } else {
      vol = `${this.rawProps.volumeMm3.toFixed(4)} mm³`;
      area = `${this.rawProps.surfaceAreaMm2.toFixed(4)} mm²`;
    }

    const massG = (this.rawProps.volumeMm3 / 1000) * density;
    let mass: string;
    if (massUnit === 'kg') {
      mass = `${(massG / 1000).toFixed(4)} kg`;
    } else if (massUnit === 'lbs') {
      mass = `${(massG / 453.592).toFixed(4)} lbs`;
    } else {
      mass = `${massG.toFixed(4)} g`;
    }

    this.volVal.textContent = vol;
    this.areaVal.textContent = area;
    this.massVal.textContent = mass;
    this.resultsEl.classList.add('visible');
  }

  private showError(msg: string): void {
    this.errorEl.textContent = msg;
    this.errorEl.classList.add('visible');
  }

  setSelectedShape(shapeId: string | null): void {
    if (shapeId === this.selectedShapeId) {
      return;
    }

    // Clear results when switching to a different shape or deselecting
    this.rawProps = null;
    this.resultsEl.classList.remove('visible');
    this.errorEl.classList.remove('visible');

    this.selectedShapeId = shapeId;

    if (shapeId) {
      this.placeholderEl.style.display = 'none';
      this.formEl.style.display = 'block';
    } else {
      this.placeholderEl.style.display = 'block';
      this.formEl.style.display = 'none';
    }
  }

  // kept for backward compat with WS message
  show(shapeId: string): void {
    this.setSelectedShape(shapeId);
    this.open();
  }
}
