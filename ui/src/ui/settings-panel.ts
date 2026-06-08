import { viewerSettings } from '../scene/viewer-settings';
import { savePreference } from '../api';
import { ICON_FIT, ICON_VIDEO, ICON_GRID, ICON_SUN, ICON_MOON, ICON_SECTION_VIEW, ICON_SETTINGS, ICON_CLOSE, ICON_ADJUSTMENTS } from './icons';

const FAB_BTN = 'btn btn-ghost btn-circle btn-sm text-base-content/60';
const FAB_BTN_ACTIVE = 'btn btn-soft btn-primary btn-circle btn-sm';

function getCurrentTheme(): string {
  return document.documentElement.getAttribute('data-theme') || 'fluidcad-dark';
}

function isDarkTheme(): boolean {
  return getCurrentTheme() !== 'fluidcad-light';
}

export class SettingsPanel {
  private wrapper: HTMLDivElement;
  private fabEl: HTMLDivElement;
  private fitEl: HTMLButtonElement;
  private paramsEl: HTMLButtonElement;
  private sectionViewEl: HTMLDivElement;
  private onFitView: (() => void) | null = null;
  private onParamsToggle: (() => void) | null = null;
  private onSectionViewToggle: ((enabled: boolean) => void) | null = null;

  constructor(
    container: HTMLElement,
    private onCameraSwitch: (mode: 'perspective' | 'orthographic') => void,
  ) {
    const style = document.createElement('style');
    style.textContent = `
      .settings-fab:not(:focus-within) > :nth-child(n+3) {
        display: none !important;
      }
    `;
    document.head.appendChild(style);

    this.wrapper = document.createElement('div');
    this.wrapper.className = 'absolute right-7 top-[100px] z-[100] flex flex-col items-end select-none';
    container.appendChild(this.wrapper);
    const wrapper = this.wrapper;

    // Section view button — own container, hidden by default
    this.sectionViewEl = document.createElement('div');
    this.sectionViewEl.className = 'mb-2';
    this.sectionViewEl.style.display = 'none';
    this.sectionViewEl.innerHTML = `<button class="${FAB_BTN_ACTIVE}" data-action="section-view" title="Toggle section view">${ICON_SECTION_VIEW}</button>`;
    wrapper.appendChild(this.sectionViewEl);

    // FAB speed dial
    this.fabEl = document.createElement('div');
    this.fabEl.className = 'fab settings-fab !relative !bottom-auto !end-auto !flex-col';
    this.fabEl.innerHTML = this.buildFabHTML();
    wrapper.appendChild(this.fabEl);

    // Standalone fit-to-view button
    this.fitEl = document.createElement('button');
    this.fitEl.className = 'btn btn-circle btn-sm panel-bg border border-base-content/10 text-base-content/60 mt-2';
    this.fitEl.title = 'Fit to view';
    this.fitEl.innerHTML = ICON_FIT;
    wrapper.appendChild(this.fitEl);

    // Parameters toggle button
    this.paramsEl = document.createElement('button');
    this.paramsEl.className = 'btn btn-circle btn-sm panel-bg border border-base-content/10 text-base-content/60 mt-2';
    this.paramsEl.title = 'Toggle parameters';
    this.paramsEl.innerHTML = ICON_ADJUSTMENTS;
    this.paramsEl.style.display = 'none';
    wrapper.appendChild(this.paramsEl);

    this.bindEvents();
    viewerSettings.subscribe(() => this.sync());
  }

  private buildFabHTML(): string {
    const s = viewerSettings.current;
    const themeIcon = isDarkTheme() ? ICON_SUN : ICON_MOON;
    const themeLabel = isDarkTheme() ? 'Light theme' : 'Dark theme';
    const cameraLabel = s.cameraMode === 'orthographic' ? 'Orthographic' : 'Perspective';

    return `
      <div tabindex="0" role="button" class="btn btn-circle btn-sm panel-bg border border-base-content/10 text-base-content/60" title="Scene settings">${ICON_SETTINGS}</div>
      <div class="fab-close !top-0 !bottom-auto">
        <span class="btn btn-circle btn-sm panel-bg border border-base-content/10">${ICON_CLOSE}</span>
      </div>
      <div>Grid <button class="${s.showGrid ? FAB_BTN_ACTIVE : FAB_BTN}" data-action="grid" title="Toggle grid">${ICON_GRID}</button></div>
      <div>
        <span data-camera-label>${cameraLabel}</span>
        <button class="${FAB_BTN}" data-action="camera" title="Toggle projection">${ICON_VIDEO}</button>
      </div>
      <div>
        <span data-theme-label>${themeLabel}</span>
        <button class="${FAB_BTN}" data-action="theme" title="${isDarkTheme() ? 'Switch to light theme' : 'Switch to dark theme'}">${themeIcon}</button>
      </div>
    `;
  }

  private bindEvents(): void {
    this.fitEl.addEventListener('click', () => {
      this.onFitView?.();
    });

    this.paramsEl.addEventListener('click', () => {
      this.onParamsToggle?.();
    });

    this.fabEl.querySelector<HTMLButtonElement>('[data-action="camera"]')?.addEventListener('click', () => {
      const next = viewerSettings.current.cameraMode === 'perspective' ? 'orthographic' : 'perspective';
      viewerSettings.update({ cameraMode: next });
      savePreference('cameraMode', next);
      this.onCameraSwitch(next);
    });

    this.fabEl.querySelector<HTMLButtonElement>('[data-action="grid"]')?.addEventListener('click', () => {
      const next = !viewerSettings.current.showGrid;
      viewerSettings.update({ showGrid: next });
      savePreference('showGrid', next);
    });

    this.sectionViewEl.querySelector<HTMLButtonElement>('[data-action="section-view"]')?.addEventListener('click', () => {
      const next = !viewerSettings.current.sectionView;
      viewerSettings.update({ sectionView: next });
      this.onSectionViewToggle?.(next);
    });

    this.fabEl.querySelector<HTMLButtonElement>('[data-action="theme"]')?.addEventListener('click', () => {
      const next = isDarkTheme() ? 'fluidcad-light' : 'fluidcad-dark';
      document.documentElement.setAttribute('data-theme', next);
      this.syncThemeButton();
      savePreference('theme', next);
    });
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
    this.paramsEl.className = active
      ? FAB_BTN_ACTIVE + ' mt-2'
      : 'btn btn-circle btn-sm panel-bg border border-base-content/10 text-base-content/60 mt-2';
  }

  setSectionViewToggleHandler(fn: (enabled: boolean) => void): void {
    this.onSectionViewToggle = fn;
  }

  setSectionViewVisible(visible: boolean): void {
    this.sectionViewEl.style.display = visible ? '' : 'none';
  }

  setSectionViewActive(active: boolean): void {
    const btn = this.sectionViewEl.querySelector<HTMLButtonElement>('[data-action="section-view"]');
    if (btn) { btn.className = active ? FAB_BTN_ACTIVE : FAB_BTN; }
  }

  setProjectionLocked(locked: boolean): void {
    const btn = this.fabEl.querySelector<HTMLButtonElement>('[data-action="camera"]');
    if (btn) { btn.disabled = locked; }
  }

  private syncThemeButton(): void {
    const btn = this.fabEl.querySelector<HTMLButtonElement>('[data-action="theme"]');
    if (btn) {
      btn.innerHTML = isDarkTheme() ? ICON_SUN : ICON_MOON;
      btn.title = isDarkTheme() ? 'Switch to light theme' : 'Switch to dark theme';
    }
    const label = this.fabEl.querySelector<HTMLElement>('[data-theme-label]');
    if (label) {
      label.textContent = isDarkTheme() ? 'Light theme' : 'Dark theme';
    }
  }

  private sync(): void {
    const s = viewerSettings.current;
    const gridBtn = this.fabEl.querySelector<HTMLButtonElement>('[data-action="grid"]');
    if (gridBtn) {
      gridBtn.className = s.showGrid ? FAB_BTN_ACTIVE : FAB_BTN;
    }
    const cameraLabel = this.fabEl.querySelector<HTMLElement>('[data-camera-label]');
    if (cameraLabel) {
      cameraLabel.textContent = s.cameraMode === 'orthographic' ? 'Orthographic' : 'Perspective';
    }
    if (this.sectionViewEl.style.display !== 'none') {
      const sectionBtn = this.sectionViewEl.querySelector<HTMLButtonElement>('[data-action="section-view"]');
      if (sectionBtn) {
        sectionBtn.className = s.sectionView ? FAB_BTN_ACTIVE : FAB_BTN;
      }
    }
  }
}
