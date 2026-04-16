import { viewerSettings } from '../scene/viewer-settings';
import { ICON_FIT, ICON_ORTHO, ICON_PERSP, ICON_GRID, ICON_SUN, ICON_MOON, ICON_SECTION_VIEW } from './icons';

const BTN_BASE = 'btn btn-ghost btn-square btn-sm text-base-content/60';
const BTN_ACTIVE = 'btn btn-soft btn-primary btn-square btn-sm';

function getCurrentTheme(): string {
  return document.documentElement.getAttribute('data-theme') || 'fluidcad-dark';
}

function isDarkTheme(): boolean {
  return getCurrentTheme() !== 'fluidcad-light';
}

export class SettingsPanel {
  private el: HTMLDivElement;
  private sectionViewEl: HTMLDivElement;
  private onFitView: (() => void) | null = null;
  private onSectionViewToggle: ((enabled: boolean) => void) | null = null;

  constructor(
    container: HTMLElement,
    private onCameraSwitch: (mode: 'perspective' | 'orthographic') => void,
  ) {
    // Wrapper so both containers share one positioning anchor
    const wrapper = document.createElement('div');
    wrapper.className = 'absolute right-6 top-1/2 -translate-y-1/2 z-[100] flex flex-col items-end gap-2 select-none';
    container.appendChild(wrapper);

    // Section view button — own container, hidden by default
    this.sectionViewEl = document.createElement('div');
    this.sectionViewEl.className = 'panel-bg border border-base-content/10 rounded-md p-1';
    this.sectionViewEl.style.display = 'none';
    this.sectionViewEl.innerHTML = `<button class="${BTN_ACTIVE}" data-action="section-view" title="Toggle section view">${ICON_SECTION_VIEW}</button>`;
    wrapper.appendChild(this.sectionViewEl);

    // Main settings panel
    this.el = document.createElement('div');
    this.el.className = 'flex flex-col gap-0.5 panel-bg border border-base-content/10 rounded-md p-1';
    this.el.innerHTML = this.buildHTML();
    wrapper.appendChild(this.el);

    this.bindEvents();
    viewerSettings.subscribe(() => this.sync());
  }

  private buildHTML(): string {
    const s = viewerSettings.current;
    const themeIcon = isDarkTheme() ? ICON_SUN : ICON_MOON;
    const themeTitle = isDarkTheme() ? 'Switch to light theme' : 'Switch to dark theme';
    return `
      <button class="${BTN_BASE}" data-action="fit" title="Fit to view">${ICON_FIT}</button>
      <div class="h-px bg-base-content/[0.08] my-0.5"></div>
      <button class="${BTN_BASE} ${s.cameraMode === 'orthographic' ? BTN_ACTIVE : ''}" data-mode="orthographic" title="Orthographic projection">${ICON_ORTHO}</button>
      <button class="${BTN_BASE} ${s.cameraMode === 'perspective' ? BTN_ACTIVE : ''}" data-mode="perspective" title="Perspective projection">${ICON_PERSP}</button>
      <div class="h-px bg-base-content/[0.08] my-0.5"></div>
      <button class="${BTN_BASE} ${s.showGrid ? BTN_ACTIVE : ''}" data-action="grid" title="Toggle grid">${ICON_GRID}</button>
      <div class="h-px bg-base-content/[0.08] my-0.5"></div>
      <button class="${BTN_BASE}" data-action="theme" title="${themeTitle}">${themeIcon}</button>
    `;
  }

  private bindEvents(): void {
    this.el.querySelector<HTMLButtonElement>('[data-action="fit"]')?.addEventListener('click', () => {
      this.onFitView?.();
    });

    this.el.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.mode as 'perspective' | 'orthographic';
        viewerSettings.update({ cameraMode: mode });
        this.onCameraSwitch(mode);
      });
    });

    this.el.querySelector<HTMLButtonElement>('[data-action="grid"]')?.addEventListener('click', () => {
      viewerSettings.update({ showGrid: !viewerSettings.current.showGrid });
    });

    this.sectionViewEl.querySelector<HTMLButtonElement>('[data-action="section-view"]')?.addEventListener('click', () => {
      const next = !viewerSettings.current.sectionView;
      viewerSettings.update({ sectionView: next });
      this.onSectionViewToggle?.(next);
    });

    this.el.querySelector<HTMLButtonElement>('[data-action="theme"]')?.addEventListener('click', () => {
      const next = isDarkTheme() ? 'fluidcad-light' : 'fluidcad-dark';
      document.documentElement.setAttribute('data-theme', next);
      this.syncThemeButton();
      fetch('/api/preferences', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ theme: next }),
      });
    });
  }

  setFitHandler(fn: () => void): void {
    this.onFitView = fn;
  }

  setFitButtonVisible(visible: boolean): void {
    const btn = this.el.querySelector<HTMLElement>('[data-action="fit"]');
    if (btn) { btn.style.display = visible ? '' : 'none'; }
    const sep = this.el.querySelector<HTMLElement>('.h-px');
    if (sep) { sep.style.display = visible ? '' : 'none'; }
  }

  setSectionViewToggleHandler(fn: (enabled: boolean) => void): void {
    this.onSectionViewToggle = fn;
  }

  setSectionViewVisible(visible: boolean): void {
    this.sectionViewEl.style.display = visible ? '' : 'none';
  }

  setSectionViewActive(active: boolean): void {
    const btn = this.sectionViewEl.querySelector<HTMLButtonElement>('[data-action="section-view"]');
    if (btn) { btn.className = active ? BTN_ACTIVE : BTN_BASE; }
  }

  setProjectionLocked(locked: boolean): void {
    this.el.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((btn) => {
      btn.disabled = locked;
    });
  }

  private syncThemeButton(): void {
    const btn = this.el.querySelector<HTMLButtonElement>('[data-action="theme"]');
    if (btn) {
      btn.innerHTML = isDarkTheme() ? ICON_SUN : ICON_MOON;
      btn.title = isDarkTheme() ? 'Switch to light theme' : 'Switch to dark theme';
    }
  }

  private sync(): void {
    const s = viewerSettings.current;
    this.el.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((btn) => {
      btn.className = btn.dataset.mode === s.cameraMode ? BTN_ACTIVE : BTN_BASE;
    });
    const gridBtn = this.el.querySelector<HTMLButtonElement>('[data-action="grid"]');
    if (gridBtn) {
      gridBtn.className = s.showGrid ? BTN_ACTIVE : BTN_BASE;
    }
    if (this.sectionViewEl.style.display !== 'none') {
      const sectionBtn = this.sectionViewEl.querySelector<HTMLButtonElement>('[data-action="section-view"]');
      if (sectionBtn) {
        sectionBtn.className = s.sectionView ? BTN_ACTIVE : BTN_BASE;
      }
    }
  }
}
