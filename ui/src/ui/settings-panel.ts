import { viewerSettings } from '../scene/viewer-settings';

const ICON_FIT = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2h4v4M6 14H2v-4M14 2l-5 5M2 14l5-5"/></svg>`;

const ICON_ORTHO = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="10" height="10"/></svg>`;

const ICON_PERSP = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 3h5l2.5 10h-10z"/></svg>`;

const ICON_GRID = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="12" height="12"/><line x1="2" y1="6.67" x2="14" y2="6.67"/><line x1="2" y1="9.33" x2="14" y2="9.33" /><line x1="6" y1="2" x2="6" y2="14"/><line x1="10" y1="2" x2="10" y2="14"/></svg>`;

const STYLES = `
.viewer-toolbar {
  position: absolute;
  top: 88px;
  right: 24px;
  z-index: 100;
  display: flex;
  flex-direction: column;
  gap: 2px;
  background: rgba(30, 30, 30, 0.85);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border-radius: 6px;
  padding: 4px;
  user-select: none;
}

.viewer-toolbar button {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: #999;
  cursor: pointer;
  padding: 0;
  transition: background 0.15s, color 0.15s;
}

.viewer-toolbar button:hover {
  background: rgba(255, 255, 255, 0.1);
  color: #e0e0e0;
}

.viewer-toolbar button:active {
  background: rgba(74, 158, 255, 0.25);
}

.viewer-toolbar button.active {
  background: rgba(74, 158, 255, 0.2);
  color: #4a9eff;
}

.viewer-toolbar button:disabled {
  opacity: 0.35;
  cursor: not-allowed;
  pointer-events: none;
}

.viewer-toolbar .tb-sep {
  height: 1px;
  background: rgba(255, 255, 255, 0.08);
  margin: 2px 0;
}
`;

export class SettingsPanel {
  private el: HTMLDivElement;
  private onFitView: (() => void) | null = null;

  constructor(
    container: HTMLElement,
    private onCameraSwitch: (mode: 'perspective' | 'orthographic') => void,
  ) {
    if (!document.getElementById('viewer-toolbar-styles')) {
      const style = document.createElement('style');
      style.id = 'viewer-toolbar-styles';
      style.textContent = STYLES;
      document.head.appendChild(style);
    }

    this.el = document.createElement('div');
    this.el.className = 'viewer-toolbar';
    this.el.innerHTML = this.buildHTML();
    container.appendChild(this.el);

    this.bindEvents();
    viewerSettings.subscribe(() => this.sync());
  }

  private buildHTML(): string {
    const s = viewerSettings.current;
    return `
      <button data-action="fit" title="Fit to view">${ICON_FIT}</button>
      <div class="tb-sep"></div>
      <button data-mode="orthographic" title="Orthographic projection" class="${s.cameraMode === 'orthographic' ? 'active' : ''}">${ICON_ORTHO}</button>
      <button data-mode="perspective" title="Perspective projection" class="${s.cameraMode === 'perspective' ? 'active' : ''}">${ICON_PERSP}</button>
      <div class="tb-sep"></div>
      <button data-action="grid" title="Toggle grid" class="${s.showGrid ? 'active' : ''}">${ICON_GRID}</button>
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
    if (btn) btn.style.display = visible ? '' : 'none';
    const sep = this.el.querySelector<HTMLElement>('.tb-sep');
    if (sep) sep.style.display = visible ? '' : 'none';
  }

  setProjectionLocked(locked: boolean): void {
    this.el.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((btn) => {
      btn.disabled = locked;
    });
  }

  private sync(): void {
    const s = viewerSettings.current;
    this.el.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.mode === s.cameraMode);
    });
    const gridBtn = this.el.querySelector<HTMLButtonElement>('[data-action="grid"]');
    if (gridBtn) gridBtn.classList.toggle('active', s.showGrid);
  }
}
