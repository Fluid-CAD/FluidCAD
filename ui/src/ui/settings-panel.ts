import { viewerSettings } from '../scene/viewer-settings';
import { viewportChrome } from './viewport-chrome';
import type { EngineClient } from '../engine-client';
import { ICON_FIT, ICON_VIDEO, ICON_GRID, ICON_GIZMO, ICON_EYE, ICON_CLOSE, ICON_ADJUSTMENTS, ICON_SECTION_VIEW } from './icons';

const FAB_BTN = 'btn btn-ghost btn-circle btn-sm text-base-content/60';
const FAB_BTN_ACTIVE = 'btn btn-soft btn-primary btn-circle btn-sm';
const STACK_BTN = 'btn btn-circle btn-sm panel-bg border border-base-content/10 text-base-content/60 mt-2';
const STACK_BTN_ACTIVE = FAB_BTN_ACTIVE + ' mt-2';

export class SettingsPanel {
  private wrapper: HTMLDivElement;
  private fabEl: HTMLDivElement;
  private sectionEl: HTMLButtonElement;
  private fitEl: HTMLButtonElement;
  private paramsEl: HTMLButtonElement;
  private onFitView: (() => void) | null = null;
  private onSectionClick: ((anchor: HTMLElement) => void) | null = null;
  /** Sketch mode takes fit-to-view away; the host gate can take it for good. */
  private fitVisibleForScene = true;
  private fitEnabled = true;
  private onParamsToggle: (() => void) | null = null;

  constructor(
    container: HTMLElement,
    private client: EngineClient,
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
    // Sits directly under the viewport gizmo (80px wide, 10px in from the
    // top-right of the scene): top clears its bottom edge, and right-[34px]
    // puts the 32px buttons' centre on the gizmo's centre (10 + 40 - 16).
    this.wrapper.className = 'absolute right-[34px] top-[calc(var(--fluidcad-chrome-top,104px)+92px)] z-[100] flex flex-col items-end select-none';
    container.appendChild(this.wrapper);
    const wrapper = this.wrapper;

    // FAB speed dial
    this.fabEl = document.createElement('div');
    this.fabEl.className = 'fab settings-fab !relative !bottom-auto !end-auto !flex-col';
    this.fabEl.innerHTML = this.buildFabHTML();
    wrapper.appendChild(this.fabEl);

    // Section views: opens the menu of the scene's saved section views.
    this.sectionEl = document.createElement('button');
    this.sectionEl.className = STACK_BTN;
    this.sectionEl.title = 'Section views';
    this.sectionEl.setAttribute('aria-haspopup', 'menu');
    this.sectionEl.setAttribute('aria-expanded', 'false');
    this.sectionEl.dataset.role = 'section-views';
    this.sectionEl.innerHTML = ICON_SECTION_VIEW;
    wrapper.appendChild(this.sectionEl);

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
    // A feature dialog docks in this same corner and takes the space over:
    // step out of its way (params panel included) for as long as it is open.
    viewportChrome.subscribe((dialogOpen) => {
      this.wrapper.style.display = dialogOpen ? 'none' : '';
    });
  }

  private buildFabHTML(): string {
    const s = viewerSettings.current;
    const cameraLabel = s.cameraMode === 'orthographic' ? 'Orthographic' : 'Perspective';

    return `
      <div tabindex="0" role="button" class="btn btn-circle btn-sm panel-bg border border-base-content/10 text-base-content/60" title="View">${ICON_EYE}</div>
      <div class="fab-close !top-0 !bottom-auto">
        <span class="btn btn-circle btn-sm panel-bg border border-base-content/10">${ICON_CLOSE}</span>
      </div>
      <div>Grid <button class="${s.showGrid ? FAB_BTN_ACTIVE : FAB_BTN}" data-action="grid" title="Toggle grid">${ICON_GRID}</button></div>
      <div>
        <span data-camera-label>${cameraLabel}</span>
        <button class="${FAB_BTN}" data-action="camera" title="Toggle projection">${ICON_VIDEO}</button>
      </div>
      <div>Connectors <button class="${s.showConnectors ? FAB_BTN_ACTIVE : FAB_BTN}" data-action="connectors" title="Toggle connector gizmos">${ICON_GIZMO}</button></div>
    `;
  }

  private bindEvents(): void {
    this.fitEl.addEventListener('click', () => {
      this.onFitView?.();
    });

    this.sectionEl.addEventListener('click', () => {
      this.onSectionClick?.(this.sectionEl);
    });

    this.paramsEl.addEventListener('click', () => {
      this.onParamsToggle?.();
    });

    this.fabEl.querySelector<HTMLButtonElement>('[data-action="camera"]')?.addEventListener('click', () => {
      const next = viewerSettings.current.cameraMode === 'perspective' ? 'orthographic' : 'perspective';
      viewerSettings.update({ cameraMode: next });
      this.client.savePreference('cameraMode', next);
      this.onCameraSwitch(next);
    });

    this.fabEl.querySelector<HTMLButtonElement>('[data-action="grid"]')?.addEventListener('click', () => {
      const next = !viewerSettings.current.showGrid;
      viewerSettings.update({ showGrid: next });
      this.client.savePreference('showGrid', next);
    });

    this.fabEl.querySelector<HTMLButtonElement>('[data-action="connectors"]')?.addEventListener('click', () => {
      const next = !viewerSettings.current.showConnectors;
      viewerSettings.update({ showConnectors: next });
      this.client.savePreference('showConnectors', next);
    });
  }

  get panelHost(): HTMLElement {
    return this.wrapper;
  }

  setFitHandler(fn: () => void): void {
    this.onFitView = fn;
  }

  /**
   * Per-scene visibility: sketch mode hides fit-to-view, leaving it restores
   * it. Gated by {@link setFitButtonEnabled} so a host that never wants the
   * button can't have it handed back by the next render.
   */
  setFitButtonVisible(visible: boolean): void {
    this.fitVisibleForScene = visible;
    this.applyFitVisibility();
  }

  /** Host-level gate on the fit-to-view button. */
  setFitButtonEnabled(enabled: boolean): void {
    this.fitEnabled = enabled;
    this.applyFitVisibility();
  }

  private applyFitVisibility(): void {
    const shown = this.fitEnabled && this.fitVisibleForScene;
    this.fitEl.style.display = shown ? '' : 'none';
    // The section menu shares fit-to-view's life: gone in sketch mode (the
    // sketch owns the clip there) and under the host gate.
    this.sectionEl.style.display = shown ? '' : 'none';
  }

  /** The section-views button was clicked; `anchor` is the button, for the menu to hang off. */
  setSectionHandler(fn: (anchor: HTMLElement) => void): void {
    this.onSectionClick = fn;
  }

  /** Lit while a section view is active. */
  setSectionButtonActive(active: boolean): void {
    this.sectionEl.className = active ? STACK_BTN_ACTIVE : STACK_BTN;
  }

  /**
   * The scene-settings speed dial. Hidden by hosts that embed the viewport as
   * a display rather than a tool, where grid and projection are the page's
   * decision and not the visitor's.
   */
  setSettingsButtonVisible(visible: boolean): void {
    this.fabEl.style.display = visible ? '' : 'none';
  }

  setParamsToggleHandler(fn: () => void): void {
    this.onParamsToggle = fn;
  }

  setParamsButtonVisible(visible: boolean): void {
    this.paramsEl.style.display = visible ? '' : 'none';
  }

  setParamsButtonActive(active: boolean): void {
    this.paramsEl.className = active ? STACK_BTN_ACTIVE : STACK_BTN;
  }

  setProjectionLocked(locked: boolean): void {
    const btn = this.fabEl.querySelector<HTMLButtonElement>('[data-action="camera"]');
    if (btn) { btn.disabled = locked; }
  }

  private sync(): void {
    const s = viewerSettings.current;
    const gridBtn = this.fabEl.querySelector<HTMLButtonElement>('[data-action="grid"]');
    if (gridBtn) {
      gridBtn.className = s.showGrid ? FAB_BTN_ACTIVE : FAB_BTN;
    }
    const connectorsBtn = this.fabEl.querySelector<HTMLButtonElement>('[data-action="connectors"]');
    if (connectorsBtn) {
      connectorsBtn.className = s.showConnectors ? FAB_BTN_ACTIVE : FAB_BTN;
    }
    const cameraLabel = this.fabEl.querySelector<HTMLElement>('[data-camera-label]');
    if (cameraLabel) {
      cameraLabel.textContent = s.cameraMode === 'orthographic' ? 'Orthographic' : 'Perspective';
    }
  }
}
