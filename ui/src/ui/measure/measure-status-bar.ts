import { ICON_CHEVRON_DOWN, ICON_RULER } from '../icons';

/**
 * Compact pill at the bottom-right of the viewer showing the primary
 * measurement (e.g. "Parallel dist: 62.09 mm"). Clicking it expands the
 * full measure panel.
 */
export class MeasureStatusBar {
  private el: HTMLDivElement;
  private labelEl: HTMLSpanElement;
  private valueEl: HTMLSpanElement;
  private chevronEl: HTMLSpanElement;

  constructor(container: HTMLElement, onClick: () => void) {
    this.el = document.createElement('div');
    this.el.className =
      'absolute bottom-6 right-[76px] z-[150] panel-bg border border-base-content/10 rounded-lg h-8 px-3 ' +
      'text-xs text-base-content flex items-center gap-2 ' +
      'cursor-pointer select-none hover:border-base-content/30 hidden';
    this.el.title = 'Show all measurements';

    const icon = document.createElement('span');
    icon.className = 'opacity-60 [&>svg]:w-4 [&>svg]:h-4';
    icon.innerHTML = ICON_RULER;

    this.labelEl = document.createElement('span');
    this.labelEl.className = 'text-base-content/60 whitespace-nowrap';

    this.valueEl = document.createElement('span');
    this.valueEl.className = 'font-medium tabular-nums whitespace-nowrap';

    this.chevronEl = document.createElement('span');
    this.chevronEl.className = 'opacity-60 transition-transform rotate-180';
    this.chevronEl.innerHTML = ICON_CHEVRON_DOWN;

    this.el.append(icon, this.labelEl, this.valueEl, this.chevronEl);
    this.el.addEventListener('click', onClick);
    container.appendChild(this.el);
  }

  show(label: string, value: string): void {
    this.labelEl.textContent = `${label}:`;
    this.valueEl.textContent = value;
    this.el.classList.remove('hidden');
  }

  hide(): void {
    this.el.classList.add('hidden');
  }

  setExpanded(expanded: boolean): void {
    this.chevronEl.classList.toggle('rotate-180', !expanded);
  }
}
