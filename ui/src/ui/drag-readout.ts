// Live drag readout pill — shows the dragged slider/revolute joint's
// current value (Travel in document units / Angle in degrees) while the
// user drags, so they can read a number straight into `.limits(min, max)`.
//
// Mirrors DofStatus (a bottom-center pill); sits just above it. Always
// reports the document unit / degrees — what `.limits()` takes — never the
// Measure tool's display unit, so the value is copy-pasteable. The number
// is untouched; only the suffix names the unit.

import type { MateReadout } from '../solver';
import { sceneUnit } from '../units/scene-unit';

/** One-decimal format that never prints "-0.0". */
function fmt1(n: number): string {
  const s = n.toFixed(1);
  return s === '-0.0' ? '0.0' : s;
}

export class DragReadout {
  private pill: HTMLDivElement;
  private label: HTMLSpanElement;
  private value: HTMLSpanElement;
  private errorTimer: number | null = null;

  constructor(container: HTMLElement) {
    this.pill = document.createElement('div');
    // Centered on the scene rather than the window (see dof-status.ts).
    this.pill.className = 'absolute bottom-16 left-[calc(50%+var(--fluidcad-scene-left,0px)/2)] -translate-x-1/2 z-[110] panel-bg border border-base-content/10 rounded-full px-4 py-2 text-xs text-base-content/80 select-none flex items-center gap-2 cursor-default hidden';

    this.label = document.createElement('span');
    this.label.className = 'text-base-content/50';
    this.pill.appendChild(this.label);

    this.value = document.createElement('span');
    this.value.className = 'font-medium tabular-nums';
    this.pill.appendChild(this.value);

    container.appendChild(this.pill);
  }

  /**
   * Flash a transient error in the pill (a gizmo pose commit the server
   * refused — stale line, opaque rotation). Red-bordered variant of the
   * normal readout; auto-hides.
   */
  flashError(message: string): void {
    this.clearError();
    this.label.textContent = '';
    this.value.textContent = message;
    this.pill.classList.add('border-red-500/70');
    this.value.classList.add('text-red-500');
    this.pill.classList.remove('hidden');
    this.errorTimer = window.setTimeout(() => {
      this.errorTimer = null;
      this.hide();
    }, 2500);
  }

  private clearError(): void {
    if (this.errorTimer !== null) {
      window.clearTimeout(this.errorTimer);
      this.errorTimer = null;
    }
    this.pill.classList.remove('border-red-500/70');
    this.value.classList.remove('text-red-500');
  }

  /** Show + set the value, or hide when passed null. */
  update(readout: MateReadout | null): void {
    if (!readout) {
      this.hide();
      return;
    }
    this.clearError();
    if (readout.kind === 'angle') {
      this.label.textContent = 'Angle';
      this.value.textContent = `${fmt1(readout.value)}°`;
    } else {
      this.label.textContent = 'Travel';
      this.value.textContent = `${fmt1(readout.value)} ${sceneUnit.current}`;
    }
    this.pill.classList.remove('hidden');
  }

  hide(): void {
    this.clearError();
    this.pill.classList.add('hidden');
  }

  dispose(): void {
    this.pill.remove();
  }
}
