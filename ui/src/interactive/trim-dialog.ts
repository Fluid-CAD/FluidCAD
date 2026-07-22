import { ChoiceTabs } from './create-feature/panel-controls';
import { viewportChrome } from '../ui/viewport-chrome';

export type TrimMode = 'region' | 'point';

const MODE_HINTS: Record<TrimMode, string> = {
  region: 'Hover a region to see its boundary; click to trim it away',
  point: 'Click the segments to remove; geometry is split at intersections',
};

/**
 * The trim dialog: armed from the sketch toolbar's Trim tool, it offers the
 * two trimming modes — By Region (default: click enclosed regions, the code
 * gets edge-filter targets) and By Point (the classic segment picking,
 * `trim().pick(points)`). It docks in the sketch dialog's spot like the 2D
 * op dialogs (fillet, offset).
 */
export class TrimDialog {
  /** Fired when the user switches trimming modes. */
  onModeChange?: (mode: TrimMode) => void;
  /** Fired on show/hide — main.ts suspends the sketch dialog while open. */
  onVisibilityChange?: (visible: boolean) => void;

  private readonly panel: HTMLDivElement;
  private readonly hint: HTMLDivElement;
  private readonly tabs: ChoiceTabs<TrimMode>;
  private active = false;

  constructor(container: HTMLElement, onCancel: () => void) {
    this.panel = document.createElement('div');
    this.panel.id = 'fluidcad-sketch-trim-panel';
    // top-[196px] right-4 matches the other sketch op dialogs (see
    // SketchOpService): the spot the settings/fit-to-view stack vacates.
    this.panel.className = 'hidden absolute top-[196px] right-4 z-[999] pointer-events-auto';
    this.panel.innerHTML = `
      <div class="flex flex-col items-stretch gap-3.5 w-60 bg-base-100 border border-base-300 text-base-content rounded-lg px-4 py-4 text-xs select-none shadow-md">
        <div class="flex items-center gap-2.5">
          <span class="font-medium text-sm">Trim</span>
        </div>
        <div data-role="mode-tabs" class="join w-full"></div>
        <div data-role="hint" class="text-base-content/50">${MODE_HINTS.region}</div>
        <div class="flex items-center gap-2 pt-1">
          <button data-role="done" class="btn btn-primary btn-sm flex-1">Done</button>
        </div>
      </div>
    `;
    container.appendChild(this.panel);

    this.hint = this.panel.querySelector('[data-role="hint"]')!;
    this.tabs = new ChoiceTabs<TrimMode>(
      this.panel.querySelector('[data-role="mode-tabs"]')!,
      [
        { key: 'region', label: 'By Region', title: 'Click enclosed regions to trim their boundary' },
        { key: 'point', label: 'By Point', title: 'Click individual segments to remove them' },
      ],
      'region',
    );
    this.tabs.onChange = () => {
      this.hint.textContent = MODE_HINTS[this.tabs.value];
      this.onModeChange?.(this.tabs.value);
    };

    this.panel.querySelector('[data-role="done"]')!.addEventListener('click', () => onCancel());
  }

  get isActive(): boolean {
    return this.active;
  }

  get mode(): TrimMode {
    return this.tabs.value;
  }

  show(): void {
    if (this.active) {
      return;
    }
    this.active = true;
    // By Region is the default on every activation.
    this.tabs.setValue('region');
    this.hint.textContent = MODE_HINTS.region;
    this.panel.classList.remove('hidden');
    viewportChrome.setDialogOpen(this.panel.id, true);
    this.onVisibilityChange?.(true);
  }

  hide(): void {
    if (!this.active) {
      return;
    }
    this.active = false;
    this.panel.classList.add('hidden');
    viewportChrome.setDialogOpen(this.panel.id, false);
    this.onVisibilityChange?.(false);
  }
}
