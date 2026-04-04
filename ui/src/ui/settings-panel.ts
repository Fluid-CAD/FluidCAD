import { viewerSettings } from '../scene/viewer-settings';
import { ICON_FIT, ICON_ORTHO, ICON_PERSP, ICON_GRID } from './icons';

const BTN_BASE = 'btn btn-ghost btn-square btn-sm text-base-content/60';
const BTN_ACTIVE = 'btn btn-soft btn-primary btn-square btn-sm';

export class SettingsPanel {
  private el: HTMLDivElement;
  private onFitView: (() => void) | null = null;

  constructor(
    container: HTMLElement,
    private onCameraSwitch: (mode: 'perspective' | 'orthographic') => void,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'absolute right-6 top-1/2 -translate-y-1/2 z-[100] flex flex-col gap-0.5 glass-dark border border-white/10 rounded-md p-1 select-none';
    this.el.innerHTML = this.buildHTML();
    container.appendChild(this.el);

    this.bindEvents();
    viewerSettings.subscribe(() => this.sync());
  }

  private buildHTML(): string {
    const s = viewerSettings.current;
    return `
      <button class="${BTN_BASE}" data-action="fit" title="Fit to view">${ICON_FIT}</button>
      <div class="h-px bg-white/[0.08] my-0.5"></div>
      <button class="${BTN_BASE} ${s.cameraMode === 'orthographic' ? BTN_ACTIVE : ''}" data-mode="orthographic" title="Orthographic projection">${ICON_ORTHO}</button>
      <button class="${BTN_BASE} ${s.cameraMode === 'perspective' ? BTN_ACTIVE : ''}" data-mode="perspective" title="Perspective projection">${ICON_PERSP}</button>
      <div class="h-px bg-white/[0.08] my-0.5"></div>
      <button class="${BTN_BASE} ${s.showGrid ? BTN_ACTIVE : ''}" data-action="grid" title="Toggle grid">${ICON_GRID}</button>
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

  setProjectionLocked(locked: boolean): void {
    this.el.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((btn) => {
      btn.disabled = locked;
    });
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
  }
}
