import { ICON_PAUSE } from './icons';

export class BreakpointIndicator {
  private element: HTMLDivElement;

  constructor(container: HTMLElement, onContinue?: () => void) {
    this.element = document.createElement('div');
    this.element.id = 'fluidcad-breakpoint-indicator';
    this.element.className = 'absolute bottom-6 left-1/2 -translate-x-1/2 z-[999] pointer-events-auto hidden';
    this.element.innerHTML = `
      <div class="flex items-center gap-3 panel-bg border border-warning/40 rounded-lg px-5 py-2.5 text-sm leading-none select-none">
        <span class="text-warning [&>svg]:size-5">${ICON_PAUSE}</span>
        <span class="text-base-content/80">Breakpoint Active</span>
        <div class="h-4 w-px bg-base-content/10"></div>
        <button class="text-base-content/60 hover:text-base-content transition-colors cursor-pointer fluidcad-breakpoint-continue">
          Continue
        </button>
      </div>
    `;
    container.appendChild(this.element);

    this.element.querySelector<HTMLButtonElement>('.fluidcad-breakpoint-continue')!
      .addEventListener('click', async () => {
        onContinue?.();
        try {
          await fetch('/api/clear-breakpoints', { method: 'POST' });
        } catch (err) {
          console.error('Clear breakpoints failed:', err);
        }
      });
  }

  setActive(active: boolean): void {
    this.element.classList.toggle('hidden', !active);
  }
}
