import { ICON_PAUSE } from './icons';
import { clearBreakpoints } from '../api';

/** Bottom-center resting spot, shared with the sketch DOF pill and the animate bar. */
const BOTTOM_RESTING = 'bottom-6';
/** One pill-height up, so the sketch DOF chip keeps the resting spot. */
const BOTTOM_RAISED = 'bottom-[68px]';

export class BreakpointIndicator {
  private element: HTMLDivElement;
  /** The build is paused at a breakpoint (the server's last authoritative word). */
  private active = false;
  /**
   * A sketch is being edited. A paused build that ends in a sketch is that
   * sketch's edit session, and the Finish Sketch button is its one way out —
   * a second "Continue" beside it would only compete with it, so the chip
   * stays hidden until the sketch is left.
   */
  private sketchActive = false;

  constructor(container: HTMLElement, onContinue?: () => void) {
    this.element = document.createElement('div');
    this.element.id = 'fluidcad-breakpoint-indicator';
    // z-[998]: one step under the feature dialogs, so the mobile bottom sheet
    // (which shares the indicator's screen-bottom spot) covers it while open.
    this.element.className = `absolute ${BOTTOM_RESTING} left-[calc(50%+var(--fluidcad-scene-left,0px)/2)] -translate-x-1/2 z-[998] pointer-events-auto hidden`;
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
      .addEventListener('click', () => {
        onContinue?.();
        clearBreakpoints();
      });
  }

  setActive(active: boolean): void {
    this.active = active;
    this.sync();
  }

  /** Hide the chip while a sketch is being edited (see {@link sketchActive}). */
  setSketchActive(sketchActive: boolean): void {
    this.sketchActive = sketchActive;
    this.sync();
  }

  private sync(): void {
    this.element.classList.toggle('hidden', !this.active || this.sketchActive);
  }

  /**
   * Stack the indicator above the bottom-center pill lane. The sketch DOF chip
   * sits at the resting spot, so a sketch paused on a breakpoint would render
   * both on top of each other.
   */
  setRaised(raised: boolean): void {
    this.element.classList.toggle(BOTTOM_RESTING, !raised);
    this.element.classList.toggle(BOTTOM_RAISED, raised);
  }
}
