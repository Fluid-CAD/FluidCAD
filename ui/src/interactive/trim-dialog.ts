import { ChoiceTabs, DIALOG_DOCK_CLASS, DIALOG_BODY_CLASS } from './create-feature/panel-controls';
import { viewportChrome } from '../ui/viewport-chrome';

export type TrimMode = 'region' | 'point';

const MODE_HINTS: Record<TrimMode, string> = {
  region: 'Hover a region to see its boundary; click to trim it away',
  point: 'Click the segments to remove; geometry is split at intersections',
};

/**
 * The trim dialog: armed from the sketch toolbar's Trim tool, it offers the
 * two trimming modes — By Point (default: the classic segment picking,
 * `trim().pick(points)`) and By Region (click enclosed regions, the code
 * gets edge-filter targets; parked behind "Coming soon" until its highlight
 * and synthesis coverage are ready). It docks in the sketch dialog's spot
 * like the 2D op dialogs (fillet, offset).
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
    this.panel.className = `hidden ${DIALOG_DOCK_CLASS}`;
    this.panel.innerHTML = `
      <div class="${DIALOG_BODY_CLASS}">
        <div class="flex items-center gap-2.5">
          <span class="font-medium text-sm">Trim</span>
        </div>
        <div data-role="mode-tabs" class="join w-full"></div>
        <div data-role="hint" class="text-base-content/50">${MODE_HINTS.point}</div>
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
        { key: 'point', label: 'By Point', title: 'Click individual segments to remove them' },
        { key: 'region', label: 'By Region', title: 'Coming soon', disabled: true },
      ],
      'point',
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
    // By Point is the default on every activation (By Region is parked).
    this.tabs.setValue('point');
    this.hint.textContent = MODE_HINTS.point;
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
