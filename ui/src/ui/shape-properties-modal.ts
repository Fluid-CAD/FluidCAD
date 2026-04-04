import { ICON_SCALE } from './icons';

type RawProps = { volumeMm3: number; surfaceAreaMm2: number; centroid: { x: number; y: number; z: number } };

/**
 * Convert density from g/cm³ (canonical) to [massUnit]/[lengthUnit]³ for display.
 *
 * Derivation: density [massUnit/lengthUnit³] = density [g/cm³]
 *   × (cm³ per lengthUnit³)   — volume factor
 *   ÷ (g per massUnit)        — mass factor
 */
/** cm³ contained in one cube of the given length unit. */
function cm3PerUnit(lengthUnit: string): number {
  switch (lengthUnit) {
    case 'inch': return 16.387064;       // 1 in³ = 16.387064 cm³
    case 'foot': return 28316.846592;    // 1 ft³ = 28316.847 cm³
    case 'yard': return 764554.857984;   // 1 yd³ = 764554.858 cm³
    case 'meter': return 1_000_000;      // 1 m³  = 1 000 000 cm³
    default: return 0.001;               // 1 mm³ = 0.001 cm³
  }
}

function lengthSuffix(lengthUnit: string): string {
  switch (lengthUnit) {
    case 'inch': return 'in';
    case 'foot': return 'ft';
    case 'yard': return 'yd';
    case 'meter': return 'm';
    default: return 'mm';
  }
}

function toDisplayDensity(gcm3: number, massUnit: string, lengthUnit: string): number {
  const gPerMassUnit = massUnit === 'kg' ? 1000 : massUnit === 'lbs' ? 453.592 : 1;
  return gcm3 * cm3PerUnit(lengthUnit) / gPerMassUnit;
}

/** Inverse of toDisplayDensity: convert [massUnit]/[lengthUnit]³ back to g/cm³. */
function toCanonicalDensity(display: number, massUnit: string, lengthUnit: string): number {
  const gPerMassUnit = massUnit === 'kg' ? 1000 : massUnit === 'lbs' ? 453.592 : 1;
  return display * gPerMassUnit / cm3PerUnit(lengthUnit);
}

/** Convert density from its native material unit to canonical g/cm³. */
function densityToGcm3(value: number, unit: string): number {
  switch (unit) {
    case 'kg/m³':  return value * 0.001;
    case 'g/mm³':  return value * 1000;
    case 'lbs/in³': return value * 27.6799;
    default:       return value; // g/cm³
  }
}

/** Convert canonical g/cm³ back to a material's native unit for display. */
function densityFromGcm3(gcm3: number, unit: string): number {
  switch (unit) {
    case 'kg/m³':  return gcm3 / 0.001;
    case 'g/mm³':  return gcm3 / 1000;
    case 'lbs/in³': return gcm3 / 27.6799;
    default:       return gcm3; // g/cm³
  }
}

function formatDensity(value: number): string {
  if (value === 0) { return '0'; }
  return parseFloat(value.toPrecision(6)).toString();
}

export class ShapePropertiesModal {
  private btn: HTMLButtonElement;
  private panel: HTMLDivElement;
  private placeholderEl!: HTMLDivElement;
  private formEl!: HTMLDivElement;
  private selectEl!: HTMLSelectElement;
  private densityEl!: HTMLInputElement;
  private densityUnitSelectEl!: HTMLSelectElement;
  private lengthUnitEl!: HTMLSelectElement;
  private massUnitEl!: HTMLSelectElement;
  private calcBtn!: HTMLButtonElement;
  private resultsEl!: HTMLDivElement;
  private errorEl!: HTMLDivElement;
  private volVal!: HTMLSpanElement;
  private areaVal!: HTMLSpanElement;
  private massVal!: HTMLSpanElement;
  private centroidVal!: HTMLSpanElement;

  private selectedShapeId: string | null = null;
  private rawProps: RawProps | null = null;
  /** Density stored in canonical g/cm³; derived from material or user input. */
  private canonicalDensityGcm3: number | null = null;
  /** The density unit as declared by the selected material (e.g. 'g/cm³', 'kg/m³'). */
  private currentDensityUnit: string = 'g/cm³';
  private centroidHandler: ((centroid: { x: number; y: number; z: number } | null) => void) | null = null;
  private openHandler: (() => void) | null = null;

  constructor(container: HTMLElement) {
    this.btn = document.createElement('button');
    this.btn.className = 'btn btn-ghost btn-square btn-sm absolute bottom-6 right-8 z-[100] glass-dark border border-white/10 text-base-content/60';
    this.btn.title = 'Shape Properties';
    this.btn.innerHTML = ICON_SCALE;
    container.appendChild(this.btn);

    this.panel = document.createElement('div');
    this.panel.className = 'absolute bottom-[68px] right-6 w-[300px] bg-base-100/95 backdrop-blur-xl border border-white/10 rounded-lg p-4 z-[200] shadow-[0_4px_24px_rgba(0,0,0,0.5)] text-base-content text-[13px] hidden';
    this.panel.innerHTML = this.buildHTML();
    container.appendChild(this.panel);

    this.bindRefs();
    this.bindEvents();
    this.loadMaterials();
  }

  private buildHTML(): string {
    return `
      <div class="flex items-center justify-between mb-3">
        <span class="text-xs font-semibold text-base-content/70 uppercase tracking-wider">Shape Properties</span>
        <button class="btn btn-ghost btn-xs btn-square" data-action="panel-close">\u00D7</button>
      </div>
      <div class="text-base-content/50 text-xs text-center py-2" data-ref="placeholder">Select a shape to view its properties</div>
      <div class="hidden" data-ref="form">
        <div class="flex gap-2 mb-2.5">
          <div class="flex-1">
            <label class="label text-[11px] uppercase tracking-wide">Length Unit</label>
            <select class="select select-sm select-bordered w-full" data-ref="length-unit">
              <option value="mm">mm</option>
              <option value="inch">inch</option>
              <option value="foot">foot</option>
              <option value="yard">yard</option>
              <option value="meter">meter</option>
            </select>
          </div>
          <div class="flex-1">
            <label class="label text-[11px] uppercase tracking-wide">Mass Unit</label>
            <select class="select select-sm select-bordered w-full" data-ref="mass-unit">
              <option value="g">g</option>
              <option value="kg">kg</option>
              <option value="lbs">lbs</option>
            </select>
          </div>
        </div>
        <div class="mb-2.5">
          <label class="label text-[11px] uppercase tracking-wide">Material</label>
          <select class="select select-sm select-bordered w-full" data-ref="material"></select>
        </div>
        <div class="mb-2.5">
          <label class="label text-[11px] uppercase tracking-wide">Density</label>
          <div class="flex gap-2">
            <input type="number" class="input input-sm input-bordered flex-1" data-ref="density" step="any" min="0" />
            <select class="select select-sm select-bordered w-[90px]" data-ref="density-unit">
              <option value="g/cm\u00B3">g/cm\u00B3</option>
              <option value="kg/m\u00B3">kg/m\u00B3</option>
              <option value="g/mm\u00B3">g/mm\u00B3</option>
              <option value="lbs/in\u00B3">lbs/in\u00B3</option>
            </select>
          </div>
        </div>
        <button class="btn btn-primary btn-sm w-full mt-0.5" data-action="calculate">Calculate</button>
        <div class="text-error text-[11px] mt-1.5 hidden" data-ref="error"></div>
      </div>
      <div class="mt-3 border-t border-white/[0.07] pt-2.5 hidden" data-ref="results">
        <div class="flex justify-between items-baseline py-0.5">
          <span class="text-base-content/50 text-[11px]">Volume</span>
          <span class="text-base-content/90 text-xs font-medium" data-ref="vol">\u2014</span>
        </div>
        <div class="flex justify-between items-baseline py-0.5">
          <span class="text-base-content/50 text-[11px]">Surface Area</span>
          <span class="text-base-content/90 text-xs font-medium" data-ref="area">\u2014</span>
        </div>
        <div class="flex justify-between items-baseline py-0.5">
          <span class="text-base-content/50 text-[11px]">Mass</span>
          <span class="text-base-content/90 text-xs font-medium" data-ref="mass">\u2014</span>
        </div>
        <div class="flex justify-between items-baseline py-0.5 mt-1.5">
          <span class="text-base-content/50 text-[11px]">Center of Mass</span>
          <span class="text-base-content/90 text-xs font-medium" data-ref="centroid">\u2014</span>
        </div>
      </div>
    `;
  }

  private bindRefs(): void {
    this.placeholderEl = this.panel.querySelector<HTMLDivElement>('[data-ref="placeholder"]')!;
    this.formEl = this.panel.querySelector<HTMLDivElement>('[data-ref="form"]')!;
    this.selectEl = this.panel.querySelector<HTMLSelectElement>('[data-ref="material"]')!;
    this.densityEl = this.panel.querySelector<HTMLInputElement>('[data-ref="density"]')!;
    this.densityUnitSelectEl = this.panel.querySelector<HTMLSelectElement>('[data-ref="density-unit"]')!;
    this.lengthUnitEl = this.panel.querySelector<HTMLSelectElement>('[data-ref="length-unit"]')!;
    this.massUnitEl = this.panel.querySelector<HTMLSelectElement>('[data-ref="mass-unit"]')!;
    this.calcBtn = this.panel.querySelector<HTMLButtonElement>('[data-action="calculate"]')!;
    this.resultsEl = this.panel.querySelector<HTMLDivElement>('[data-ref="results"]')!;
    this.errorEl = this.panel.querySelector<HTMLDivElement>('[data-ref="error"]')!;
    this.volVal = this.panel.querySelector<HTMLSpanElement>('[data-ref="vol"]')!;
    this.areaVal = this.panel.querySelector<HTMLSpanElement>('[data-ref="area"]')!;
    this.massVal = this.panel.querySelector<HTMLSpanElement>('[data-ref="mass"]')!;
    this.centroidVal = this.panel.querySelector<HTMLSpanElement>('[data-ref="centroid"]')!;
  }

  get isOpen(): boolean {
    return !this.panel.classList.contains('hidden');
  }

  setCentroidHandler(fn: (centroid: { x: number; y: number; z: number } | null) => void): void {
    this.centroidHandler = fn;
  }

  setOpenHandler(fn: () => void): void {
    this.openHandler = fn;
  }

  private bindEvents(): void {
    this.btn.addEventListener('click', () => this.toggle());

    this.panel.querySelector('[data-action="panel-close"]')!.addEventListener('click', () => this.close());

    this.selectEl.addEventListener('change', () => {
      const opt = this.selectEl.options[this.selectEl.selectedIndex];
      if (opt?.dataset.density) {
        this.currentDensityUnit = opt.dataset.densityUnit || 'g/cm\u00B3';
        this.canonicalDensityGcm3 = densityToGcm3(parseFloat(opt.dataset.density), this.currentDensityUnit);
        this.updateDensityUnitSelect();
        this.updateDensityDisplay();
      }
    });

    this.densityEl.addEventListener('input', () => {
      const display = parseFloat(this.densityEl.value);
      if (!isNaN(display)) {
        this.canonicalDensityGcm3 = densityToGcm3(display, this.currentDensityUnit);
      }
    });

    this.densityUnitSelectEl.addEventListener('change', () => {
      this.currentDensityUnit = this.densityUnitSelectEl.value;
      this.updateDensityDisplay();
    });

    this.lengthUnitEl.addEventListener('change', () => this.renderResults());
    this.massUnitEl.addEventListener('change', () => this.renderResults());

    this.calcBtn.addEventListener('click', () => this.calculate());
  }

  private updateDensityUnitSelect(): void {
    const opt = Array.from(this.densityUnitSelectEl.options).find(o => o.value === this.currentDensityUnit);
    if (opt) {
      this.densityUnitSelectEl.value = this.currentDensityUnit;
    } else {
      const extra = document.createElement('option');
      extra.value = this.currentDensityUnit;
      extra.textContent = this.currentDensityUnit;
      this.densityUnitSelectEl.appendChild(extra);
      this.densityUnitSelectEl.value = this.currentDensityUnit;
    }
  }

  private updateDensityDisplay(): void {
    if (this.canonicalDensityGcm3 === null) { return; }
    this.densityEl.value = formatDensity(densityFromGcm3(this.canonicalDensityGcm3, this.currentDensityUnit));
  }

  private toggle(): void {
    if (!this.panel.classList.contains('hidden')) {
      this.close();
    } else {
      this.open();
    }
  }

  private open(): void {
    this.openHandler?.();
    this.panel.classList.remove('hidden');
    this.btn.className = 'btn btn-soft btn-primary btn-square btn-sm absolute bottom-6 right-8 z-[100] glass-dark border border-white/10';
  }

  private close(): void {
    this.panel.classList.add('hidden');
    this.btn.className = 'btn btn-ghost btn-square btn-sm absolute bottom-6 right-8 z-[100] glass-dark border border-white/10 text-base-content/60';
  }

  private async loadMaterials(): Promise<void> {
    try {
      const res = await fetch('/api/materials');
      if (!res.ok) { return; }
      const materials: { name: string; density: number; densityUnit: string }[] = await res.json();
      this.selectEl.innerHTML = '';
      for (const mat of materials) {
        const opt = document.createElement('option');
        opt.textContent = mat.name;
        opt.dataset.density = String(mat.density);
        opt.dataset.densityUnit = mat.densityUnit;
        this.selectEl.appendChild(opt);
      }
      const first = this.selectEl.options[0];
      if (first?.dataset.density) {
        this.currentDensityUnit = first.dataset.densityUnit || 'g/cm\u00B3';
        this.canonicalDensityGcm3 = densityToGcm3(parseFloat(first.dataset.density), this.currentDensityUnit);
        this.updateDensityUnitSelect();
        this.updateDensityDisplay();
      }
    } catch {
      // silently ignore if materials endpoint not available
    }
  }

  private async calculate(): Promise<void> {
    if (!this.selectedShapeId) { return; }
    this.calcBtn.disabled = true;
    this.errorEl.classList.add('hidden');
    this.resultsEl.classList.add('hidden');

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
    if (!this.rawProps) { return; }

    const lengthUnit = this.lengthUnitEl.value;
    const massUnit = this.massUnitEl.value;

    const suffix = lengthSuffix(lengthUnit);
    const vol = `${this.rawProps.volumeMm3.toFixed(4)} ${suffix}\u00B3`;
    const area = `${this.rawProps.surfaceAreaMm2.toFixed(4)} ${suffix}\u00B2`;

    const densityGcm3 = this.canonicalDensityGcm3 ?? 0;
    const densityGPerVol = toDisplayDensity(densityGcm3, 'g', lengthUnit);
    const massG = this.rawProps.volumeMm3 * densityGPerVol;
    let mass: string;
    if (massUnit === 'kg') {
      mass = `${(massG / 1000).toFixed(4)} kg`;
    } else if (massUnit === 'lbs') {
      mass = `${(massG / 453.592).toFixed(4)} lbs`;
    } else {
      mass = `${massG.toFixed(4)} g`;
    }

    const { centroid } = this.rawProps;
    const f = (v: number) => v.toFixed(4);
    const centroidText = `(${f(centroid.x)}, ${f(centroid.y)}, ${f(centroid.z)}) ${suffix}`;

    this.volVal.textContent = vol;
    this.areaVal.textContent = area;
    this.massVal.textContent = mass;
    this.centroidVal.textContent = centroidText;
    this.resultsEl.classList.remove('hidden');
    this.centroidHandler?.(centroid);
  }

  private showError(msg: string): void {
    this.errorEl.textContent = msg;
    this.errorEl.classList.remove('hidden');
  }

  setSelectedShape(shapeId: string | null): void {
    if (shapeId === this.selectedShapeId) { return; }

    this.rawProps = null;
    this.resultsEl.classList.add('hidden');
    this.errorEl.classList.add('hidden');
    this.centroidHandler?.(null);

    this.selectedShapeId = shapeId;

    if (shapeId) {
      this.placeholderEl.classList.add('hidden');
      this.formEl.classList.remove('hidden');
    } else {
      this.placeholderEl.classList.remove('hidden');
      this.formEl.classList.add('hidden');
    }
  }

  // kept for backward compat with WS message
  show(shapeId: string): void {
    this.setSelectedShape(shapeId);
    this.open();
  }
}
