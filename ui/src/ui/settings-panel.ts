import { viewerSettings } from '../scene/viewer-settings';
import type { ViewerSettings } from '../scene/viewer-settings';
import type { UserPreferences } from '../api';
import { viewportChrome } from './viewport-chrome';
import type { EngineClient } from '../engine-client';
import { ICON_FIT, ICON_SETTINGS, ICON_CLOSE, ICON_ADJUSTMENTS } from './icons';
import { ANGLE_UNITS, LENGTH_UNITS, isLengthUnit } from '../units/units';
import type { AngleUnit, LengthUnit } from '../units/units';
import { sceneUnit } from '../units/scene-unit';
import { GRID_MAJOR_EVERY_RANGE, GRID_MIN_CELL_PX_RANGE } from '../grid/grid-spacing';

const CORNER_BTN = 'btn btn-circle btn-sm panel-bg border border-base-content/10 text-base-content/60';
const CORNER_BTN_ACTIVE = 'btn btn-soft btn-primary btn-circle btn-sm';

/**
 * The top-right button stack (settings gear, fit-to-view, parameters) and
 * the settings dialog the gear opens. Every control in the dialog is a
 * user preference — display-only by design: none of them changes how a
 * document is interpreted (plan §8), which is what keeps files portable.
 * Persisted through the server preferences store like every other setting
 * (no localStorage); the live `viewerSettings` store is the in-page truth
 * the consumers subscribe to.
 */
export class SettingsPanel {
  private wrapper: HTMLDivElement;
  private gearEl: HTMLButtonElement;
  private fitEl: HTMLButtonElement;
  private paramsEl: HTMLButtonElement;
  private overlay: HTMLDivElement;
  private onFitView: (() => void) | null = null;
  private onParamsToggle: (() => void) | null = null;
  private projectionLocked = false;

  private lengthUnitEl!: HTMLSelectElement;
  private angleUnitEl!: HTMLSelectElement;
  private dimensionSuffixEl!: HTMLInputElement;
  private showGridEl!: HTMLInputElement;
  private gridAdaptiveEl!: HTMLInputElement;
  private minCellEl!: HTMLInputElement;
  private fixedSpacingEl!: HTMLInputElement;
  private fixedSpacingLabel!: HTMLElement;
  private majorEveryEl!: HTMLInputElement;
  private adaptiveSection!: HTMLElement;
  private fixedSection!: HTMLElement;
  private projectionRadios!: HTMLInputElement[];
  private projectionNote!: HTMLElement;

  constructor(
    container: HTMLElement,
    private client: EngineClient,
    private onCameraSwitch: (mode: 'perspective' | 'orthographic') => void,
  ) {
    this.wrapper = document.createElement('div');
    // Clears the viewport gizmo, which occupies the top-right corner of the
    // scene (~y 102–182) below the toolbar.
    this.wrapper.className = 'absolute right-7 top-[calc(var(--fluidcad-chrome-top,104px)+92px)] z-[100] flex flex-col items-end select-none';
    container.appendChild(this.wrapper);

    this.gearEl = document.createElement('button');
    this.gearEl.className = CORNER_BTN;
    this.gearEl.title = 'Settings';
    this.gearEl.innerHTML = ICON_SETTINGS;
    this.wrapper.appendChild(this.gearEl);

    // Fit-to-view stays a one-click action — it is the one thing here
    // people reach for mid-task.
    this.fitEl = document.createElement('button');
    this.fitEl.className = `${CORNER_BTN} mt-2`;
    this.fitEl.title = 'Fit to view';
    this.fitEl.innerHTML = ICON_FIT;
    this.wrapper.appendChild(this.fitEl);

    this.paramsEl = document.createElement('button');
    this.paramsEl.className = `${CORNER_BTN} mt-2`;
    this.paramsEl.title = 'Toggle parameters';
    this.paramsEl.innerHTML = ICON_ADJUSTMENTS;
    this.paramsEl.style.display = 'none';
    this.wrapper.appendChild(this.paramsEl);

    this.overlay = document.createElement('div');
    this.overlay.className = 'fixed inset-0 z-[300] bg-black/50 flex items-center justify-center hidden';
    this.overlay.innerHTML = this.buildDialogHTML();
    container.appendChild(this.overlay);
    this.bindDialogRefs();

    this.bindEvents();
    viewerSettings.subscribe(() => this.sync());
    sceneUnit.subscribe(() => this.sync());
    this.sync();
    // A feature dialog docks in this same corner and takes the space over:
    // step out of its way (params panel included) for as long as it is open.
    viewportChrome.subscribe((dialogOpen) => {
      this.wrapper.style.display = dialogOpen ? 'none' : '';
    });
  }

  private buildDialogHTML(): string {
    const lengthOptions = LENGTH_UNITS
      .map(u => `<option value="${u.value}">${u.label} (${u.value})</option>`)
      .join('');
    const angleOptions = ANGLE_UNITS
      .map(u => `<option value="${u.value}">${u.label}</option>`)
      .join('');
    const [minPx, maxPx] = GRID_MIN_CELL_PX_RANGE;
    const [minEvery, maxEvery] = GRID_MAJOR_EVERY_RANGE;

    return `
      <div class="w-[380px] max-h-[calc(100vh-32px)] overflow-y-auto bg-base-100 border border-base-content/10 rounded-lg p-5 shadow-[0_4px_24px_rgba(0,0,0,0.5)]">
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-sm font-medium text-base-content/90">Settings</h3>
          <button data-ref="close-btn" class="btn btn-ghost btn-square btn-xs text-base-content/60">
            <span class="[&>svg]:size-4">${ICON_CLOSE}</span>
          </button>
        </div>

        <div class="flex flex-col gap-4">
          <section class="flex flex-col gap-3">
            <h4 class="text-[11px] uppercase tracking-wide text-base-content/40">Display</h4>
            <div class="flex gap-2">
              <div class="flex-1">
                <label class="text-xs text-base-content/60 mb-1 block">Measure length unit</label>
                <select data-ref="length-unit" class="select select-sm select-bordered w-full">${lengthOptions}</select>
              </div>
              <div class="flex-1">
                <label class="text-xs text-base-content/60 mb-1 block">Angle unit</label>
                <select data-ref="angle-unit" class="select select-sm select-bordered w-full">${angleOptions}</select>
              </div>
            </div>
            <label class="flex items-center justify-between cursor-pointer">
              <span class="text-xs text-base-content/70">Show unit suffix on sketch dimensions</span>
              <input type="checkbox" data-ref="dimension-suffix" class="toggle toggle-sm toggle-primary" />
            </label>
          </section>

          <section class="flex flex-col gap-3">
            <h4 class="text-[11px] uppercase tracking-wide text-base-content/40">Grid</h4>
            <label class="flex items-center justify-between cursor-pointer">
              <span class="text-xs text-base-content/70">Show grid</span>
              <input type="checkbox" data-ref="show-grid" class="toggle toggle-sm toggle-primary" />
            </label>
            <label class="flex items-center justify-between cursor-pointer">
              <span class="text-xs text-base-content/70">Adaptive spacing (follows zoom)</span>
              <input type="checkbox" data-ref="grid-adaptive" class="toggle toggle-sm toggle-primary" />
            </label>
            <div data-ref="adaptive-section">
              <label class="text-xs text-base-content/60 mb-1 block">Minimum cell size (px)</label>
              <input data-ref="min-cell" type="number" class="input input-sm input-bordered w-full" min="${minPx}" max="${maxPx}" step="1" />
            </div>
            <div data-ref="fixed-section" class="flex gap-2">
              <div class="flex-1">
                <label data-ref="fixed-spacing-label" class="text-xs text-base-content/60 mb-1 block">Spacing (mm)</label>
                <input data-ref="fixed-spacing" type="number" class="input input-sm input-bordered w-full" min="0" step="any" />
              </div>
              <div class="flex-1">
                <label class="text-xs text-base-content/60 mb-1 block">Major line every</label>
                <input data-ref="major-every" type="number" class="input input-sm input-bordered w-full" min="${minEvery}" max="${maxEvery}" step="1" />
              </div>
            </div>
          </section>

          <section class="flex flex-col gap-3">
            <h4 class="text-[11px] uppercase tracking-wide text-base-content/40">Camera</h4>
            <div>
              <label class="text-xs text-base-content/60 mb-1.5 block">Projection</label>
              <div class="join w-full border border-base-content/10 rounded-lg">
                <input class="join-item btn btn-sm flex-1 border-0 border-r border-base-content/10 checked:btn-primary" type="radio" name="settings-projection" aria-label="Orthographic" data-projection="orthographic" />
                <input class="join-item btn btn-sm flex-1 border-0 checked:btn-primary" type="radio" name="settings-projection" aria-label="Perspective" data-projection="perspective" />
              </div>
              <div data-ref="projection-note" class="text-[11px] text-base-content/40 mt-1 hidden">Sketch mode is always orthographic.</div>
            </div>
          </section>
        </div>

        <div class="flex justify-end gap-2 mt-4">
          <button data-ref="done-btn" class="btn btn-primary btn-sm">Done</button>
        </div>
      </div>
    `;
  }

  private bindDialogRefs(): void {
    const q = <T extends Element>(ref: string): T => this.overlay.querySelector<T>(`[data-ref="${ref}"]`)!;
    this.lengthUnitEl = q('length-unit');
    this.angleUnitEl = q('angle-unit');
    this.dimensionSuffixEl = q('dimension-suffix');
    this.showGridEl = q('show-grid');
    this.gridAdaptiveEl = q('grid-adaptive');
    this.minCellEl = q('min-cell');
    this.fixedSpacingEl = q('fixed-spacing');
    this.fixedSpacingLabel = q('fixed-spacing-label');
    this.majorEveryEl = q('major-every');
    this.adaptiveSection = q('adaptive-section');
    this.fixedSection = q('fixed-section');
    this.projectionNote = q('projection-note');
    this.projectionRadios = [...this.overlay.querySelectorAll<HTMLInputElement>('[data-projection]')];
  }

  private bindEvents(): void {
    this.gearEl.addEventListener('click', () => this.open());
    this.fitEl.addEventListener('click', () => {
      this.onFitView?.();
    });
    this.paramsEl.addEventListener('click', () => {
      this.onParamsToggle?.();
    });

    this.overlay.querySelector('[data-ref="close-btn"]')!.addEventListener('click', () => this.close());
    this.overlay.querySelector('[data-ref="done-btn"]')!.addEventListener('click', () => this.close());
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) {
        this.close();
      }
    });
    this.overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.close();
      }
    });

    this.lengthUnitEl.addEventListener('change', () => {
      const unit = this.lengthUnitEl.value;
      if (isLengthUnit(unit)) {
        this.commit('measureLengthUnit', unit);
      }
    });
    this.angleUnitEl.addEventListener('change', () => {
      const unit = this.angleUnitEl.value as AngleUnit;
      if (unit === 'deg' || unit === 'rad') {
        this.commit('measureAngleUnit', unit);
      }
    });
    this.dimensionSuffixEl.addEventListener('change', () => {
      this.commit('sketchDimensionSuffix', this.dimensionSuffixEl.checked);
    });

    this.showGridEl.addEventListener('change', () => {
      this.commit('showGrid', this.showGridEl.checked);
    });
    this.gridAdaptiveEl.addEventListener('change', () => {
      this.commit('gridAdaptive', this.gridAdaptiveEl.checked);
    });
    this.minCellEl.addEventListener('change', () => {
      const [min, max] = GRID_MIN_CELL_PX_RANGE;
      const value = this.clampInput(this.minCellEl, min, max);
      if (value !== null) {
        this.commit('gridMinCellPx', Math.round(value));
      }
    });
    this.fixedSpacingEl.addEventListener('change', () => {
      const value = parseFloat(this.fixedSpacingEl.value);
      if (!Number.isFinite(value) || value <= 0) {
        this.sync();
        return;
      }
      // The field edits the CURRENT document unit's pitch; the other
      // units keep theirs. The record is what gets persisted.
      const unit: LengthUnit = sceneUnit.current;
      const spacing = { ...viewerSettings.current.gridFixedSpacing, [unit]: value };
      this.commit('gridFixedSpacing', spacing);
    });
    this.majorEveryEl.addEventListener('change', () => {
      const [min, max] = GRID_MAJOR_EVERY_RANGE;
      const value = this.clampInput(this.majorEveryEl, min, max);
      if (value !== null) {
        this.commit('gridMajorEvery', Math.round(value));
      }
    });

    for (const radio of this.projectionRadios) {
      radio.addEventListener('change', () => {
        if (!radio.checked) {
          return;
        }
        const mode = radio.dataset.projection === 'perspective' ? 'perspective' : 'orthographic';
        this.commit('cameraMode', mode);
        this.onCameraSwitch(mode);
      });
    }
  }

  /** Live-apply through the settings store and persist. */
  private commit<K extends keyof ViewerSettings & keyof UserPreferences>(
    key: K,
    value: ViewerSettings[K] & UserPreferences[K],
  ): void {
    viewerSettings.update({ [key]: value });
    this.client.savePreference(key, value);
  }

  /** Parse a numeric field, clamp it into range, write the clamp back. */
  private clampInput(input: HTMLInputElement, min: number, max: number): number | null {
    const raw = parseFloat(input.value);
    if (!Number.isFinite(raw)) {
      this.sync();
      return null;
    }
    const value = Math.min(max, Math.max(min, raw));
    input.value = String(value);
    return value;
  }

  private open(): void {
    this.sync();
    this.overlay.classList.remove('hidden');
    this.lengthUnitEl.focus();
  }

  private close(): void {
    this.overlay.classList.add('hidden');
  }

  get panelHost(): HTMLElement {
    return this.wrapper;
  }

  setFitHandler(fn: () => void): void {
    this.onFitView = fn;
  }

  setFitButtonVisible(visible: boolean): void {
    this.fitEl.style.display = visible ? '' : 'none';
  }

  setParamsToggleHandler(fn: () => void): void {
    this.onParamsToggle = fn;
  }

  setParamsButtonVisible(visible: boolean): void {
    this.paramsEl.style.display = visible ? '' : 'none';
  }

  setParamsButtonActive(active: boolean): void {
    this.paramsEl.className = active ? `${CORNER_BTN_ACTIVE} mt-2` : `${CORNER_BTN} mt-2`;
  }

  /** Sketch mode forces orthographic: the projection choice goes inert. */
  setProjectionLocked(locked: boolean): void {
    this.projectionLocked = locked;
    this.sync();
  }

  /** Mirror the stores into the controls (never the other way). */
  private sync(): void {
    const s = viewerSettings.current;
    const unit = sceneUnit.current;
    this.lengthUnitEl.value = s.measureLengthUnit;
    this.angleUnitEl.value = s.measureAngleUnit;
    this.dimensionSuffixEl.checked = s.sketchDimensionSuffix;
    this.showGridEl.checked = s.showGrid;
    this.gridAdaptiveEl.checked = s.gridAdaptive;
    this.minCellEl.value = String(s.gridMinCellPx);
    this.fixedSpacingLabel.textContent = `Spacing (${unit})`;
    this.fixedSpacingEl.value = String(s.gridFixedSpacing[unit]);
    this.majorEveryEl.value = String(s.gridMajorEvery);
    this.adaptiveSection.classList.toggle('hidden', !s.gridAdaptive);
    this.fixedSection.classList.toggle('hidden', s.gridAdaptive);
    for (const radio of this.projectionRadios) {
      radio.checked = radio.dataset.projection === s.cameraMode;
      radio.disabled = this.projectionLocked;
    }
    this.projectionNote.classList.toggle('hidden', !this.projectionLocked);
  }
}
