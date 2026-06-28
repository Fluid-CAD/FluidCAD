// Live drag readout pill — shows the dragged slider/revolute joint's
// current value (Travel in mm / Angle in degrees) while the user drags,
// so they can read a number straight into `.limits(min, max)`.
//
// Mirrors DofStatus (a bottom-center pill); sits just above it. Always
// reports mm / degrees — the units `.limits()` takes — regardless of the
// Measure tool's display-unit setting, so the value is copy-pasteable.

import type { MateReadout } from '../solver';

/** One-decimal format that never prints "-0.0". */
function fmt1(n: number): string {
  const s = n.toFixed(1);
  return s === '-0.0' ? '0.0' : s;
}

export class DragReadout {
  private pill: HTMLDivElement;
  private label: HTMLSpanElement;
  private value: HTMLSpanElement;

  constructor(container: HTMLElement) {
    this.pill = document.createElement('div');
    this.pill.className = 'absolute bottom-16 left-1/2 -translate-x-1/2 z-[110] panel-bg border border-base-content/10 rounded-full px-4 py-2 text-xs text-base-content/80 select-none flex items-center gap-2 cursor-default hidden';

    this.label = document.createElement('span');
    this.label.className = 'text-base-content/50';
    this.pill.appendChild(this.label);

    this.value = document.createElement('span');
    this.value.className = 'font-medium tabular-nums';
    this.pill.appendChild(this.value);

    container.appendChild(this.pill);
  }

  /** Show + set the value, or hide when passed null. */
  update(readout: MateReadout | null): void {
    if (!readout) {
      this.hide();
      return;
    }
    if (readout.kind === 'angle') {
      this.label.textContent = 'Angle';
      this.value.textContent = `${fmt1(readout.value)}°`;
    } else {
      this.label.textContent = 'Travel';
      this.value.textContent = `${fmt1(readout.value)} mm`;
    }
    this.pill.classList.remove('hidden');
  }

  hide(): void {
    this.pill.classList.add('hidden');
  }

  dispose(): void {
    this.pill.remove();
  }
}
