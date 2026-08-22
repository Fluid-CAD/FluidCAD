// Animate bar — drives a 1-DOF mate (revolute angle / slider travel)
// from a start value to an end value in N steps, once or looping.
//
// Opened from a joint row's "Animate…" menu entry. A horizontal pill
// sitting just above the DOF status chip (where the drag readout shows
// during a pointer drag — the two never show together: driving a mate
// refuses while a drag owns the assembly, and a drag can't start from the
// bar's inputs). Values are in the readout's units — degrees / mm, the
// same numbers `.limits()` takes.
//
// Manual test plan:
//  1. Right-click a revolute/slider row → Animate… → bar appears with
//     Start = current value, End = upper limit (or +90° / +10 mm).
//  2. Play → the follower sweeps start→end over `Steps` frames; Single
//     stops at the end, Loop reciprocates (start→end→start…) until Stop.
//  3. Play toggles to Pause mid-sweep; Stop returns the part to where it
//     was when the bar opened. × closes the bar (stopping first).
//  4. Edit Start/End while paused → next Play restarts from Start.

import { ICON_CLOSE, ICON_PAUSE, ICON_PLAY, ICON_STOP } from './icons';
import type { MateReadout } from '../solver';

const STEP_INTERVAL_MS = 40;
const DEFAULT_STEPS = 30;

export interface AnimateBarHost {
  /** Current value of the mate, or null when it can't be driven. */
  getMateDriveState(mateId: string): MateReadout | null;
  /** Drive the mate to `value`; false when the mate can't be driven (right now). */
  driveMateValue(mateId: string, value: number): boolean;
  /** Playback paused/stopped: re-solve without the driver (restores the DOF readout). */
  settle(): void;
}

export interface AnimateTarget {
  mateId: string;
  label: string;
  kind: MateReadout['kind'];
  /** Authored `.limits(min, max)`, used to seed Start/End. */
  limits?: [number, number];
}

type Playback = 'single' | 'loop';

export class AnimateBar {
  private bar: HTMLDivElement;
  private title: HTMLSpanElement;
  private startInput: HTMLInputElement;
  private endInput: HTMLInputElement;
  private stepsInput: HTMLInputElement;
  private playbackSelect: HTMLSelectElement;
  private playButton: HTMLButtonElement;
  private stopButton: HTMLButtonElement;

  private target: AnimateTarget | null = null;
  /** Mate value when the bar opened — Stop restores it. */
  private restValue = 0;
  /** rAF handle while playing; null when paused/stopped. */
  private timer: number | null = null;
  private lastTickAt = 0;
  /** Current step index, 0..steps; `direction` flips at the ends in loop mode. */
  private step = 0;
  private direction: 1 | -1 = 1;

  constructor(
    container: HTMLElement,
    private readonly host: AnimateBarHost,
    private readonly onClose: () => void,
  ) {
    this.bar = document.createElement('div');
    // Centered on the scene rather than the window (see dof-status.ts).
    this.bar.className = 'absolute bottom-16 left-[calc(50%+var(--fluidcad-editor-width,0px)/2)] -translate-x-1/2 z-[115] panel-bg border border-base-content/10 rounded-full pl-4 pr-2 py-1.5 text-xs text-base-content/80 select-none flex items-center gap-3 cursor-default hidden';
    this.bar.innerHTML = `
      <span data-ref="title" class="font-medium whitespace-nowrap"></span>
      <label class="flex items-center gap-1.5 whitespace-nowrap"><span class="text-base-content/50">Start</span><input data-ref="start" type="number" step="any" class="input input-xs input-bordered w-20 tabular-nums" /></label>
      <label class="flex items-center gap-1.5 whitespace-nowrap"><span class="text-base-content/50">End</span><input data-ref="end" type="number" step="any" class="input input-xs input-bordered w-20 tabular-nums" /></label>
      <label class="flex items-center gap-1.5 whitespace-nowrap"><span class="text-base-content/50">Steps</span><input data-ref="steps" type="number" min="1" step="1" class="input input-xs input-bordered w-16 tabular-nums" /></label>
      <label class="flex items-center gap-1.5 whitespace-nowrap"><span class="text-base-content/50">Playback</span>
        <select data-ref="playback" class="select select-xs select-bordered w-24">
          <option value="single">Single</option>
          <option value="loop">Loop</option>
        </select>
      </label>
      <span class="flex items-center gap-0.5">
        <button data-ref="play" class="btn btn-ghost btn-square btn-xs [&>svg]:size-4" title="Play"></button>
        <button data-ref="stop" class="btn btn-ghost btn-square btn-xs [&>svg]:size-4" title="Stop"></button>
        <button data-ref="close" class="btn btn-ghost btn-square btn-xs text-base-content/50 [&>svg]:size-4" title="Close"></button>
      </span>
    `;
    container.appendChild(this.bar);

    const ref = <T extends HTMLElement>(name: string) => this.bar.querySelector<T>(`[data-ref="${name}"]`)!;
    this.title = ref('title');
    this.startInput = ref('start');
    this.endInput = ref('end');
    this.stepsInput = ref('steps');
    this.playbackSelect = ref('playback');
    this.playButton = ref('play');
    this.stopButton = ref('stop');
    this.stopButton.innerHTML = ICON_STOP;
    ref<HTMLButtonElement>('close').innerHTML = ICON_CLOSE;

    this.playButton.addEventListener('click', () => {
      if (this.timer !== null) {
        this.pause();
      } else {
        this.play();
      }
    });
    this.stopButton.addEventListener('click', () => this.stop());
    ref('close').addEventListener('click', () => this.close());
    // Typing in the inputs must not reach the viewer's keyboard shortcuts.
    this.bar.addEventListener('keydown', (e) => e.stopPropagation());
    this.bar.addEventListener('pointerdown', (e) => e.stopPropagation());

    this.renderPlayButton();
  }

  /** Open (or retarget) the bar for a mate. Stops any running animation first. */
  open(target: AnimateTarget): void {
    this.pause();
    const current = this.host.getMateDriveState(target.mateId);
    this.target = target;
    this.restValue = current?.value ?? 0;
    this.step = 0;
    this.direction = 1;
    const unit = target.kind === 'angle' ? '°' : ' mm';
    this.title.textContent = `${target.label} (${unit.trim()})`;
    const start = current?.value ?? target.limits?.[0] ?? 0;
    const end = target.limits?.[1] ?? start + (target.kind === 'angle' ? 90 : 10);
    this.startInput.value = fmt(start);
    this.endInput.value = fmt(end);
    this.stepsInput.value = String(DEFAULT_STEPS);
    this.bar.classList.remove('hidden');
    this.renderPlayButton();
  }

  isOpen(): boolean {
    return !this.bar.classList.contains('hidden');
  }

  /** The mate the bar is driving, or null. */
  mateId(): string | null {
    return this.target?.mateId ?? null;
  }

  close(): void {
    if (!this.isOpen()) return;
    this.stop();
    this.target = null;
    this.bar.classList.add('hidden');
    this.onClose();
  }

  dispose(): void {
    this.pause();
    this.bar.remove();
  }

  private play(): void {
    if (!this.target) return;
    const steps = this.steps();
    // A sweep that already ran to the end restarts from the start.
    if (this.playback() === 'single' && this.step >= steps) {
      this.step = 0;
    }
    if (!this.drive(this.valueAt(this.step))) {
      return;
    }
    this.lastTickAt = performance.now();
    this.timer = window.requestAnimationFrame(this.frame);
    this.renderPlayButton();
  }

  /**
   * One animation frame: advance a step when STEP_INTERVAL_MS has
   * elapsed since the last one. Frame-paced (not setInterval) so a solve
   * slower than the interval — a loop with tangent contacts — drops
   * frames instead of queueing a backlog of ticks.
   */
  private frame = (now: number): void => {
    if (this.timer === null) return;
    if (now - this.lastTickAt >= STEP_INTERVAL_MS) {
      this.lastTickAt = now;
      this.tick();
      if (this.timer === null) return;
    }
    this.timer = window.requestAnimationFrame(this.frame);
  };

  private pause(): void {
    if (this.timer !== null) {
      window.cancelAnimationFrame(this.timer);
      this.timer = null;
      this.host.settle();
    }
    this.renderPlayButton();
  }

  private stop(): void {
    this.pause();
    this.step = 0;
    this.direction = 1;
    if (this.target) {
      this.drive(this.restValue);
      this.host.settle();
    }
  }

  private tick(): void {
    const steps = this.steps();
    if (this.playback() === 'single') {
      if (this.step >= steps) {
        this.pause();
        return;
      }
      this.step += 1;
    } else {
      // Reciprocate: bounce at both ends so the mechanism never jumps.
      if (this.step >= steps) this.direction = -1;
      if (this.step <= 0) this.direction = 1;
      this.step += this.direction;
    }
    if (!this.drive(this.valueAt(this.step))) {
      this.pause();
    }
  }

  private drive(value: number): boolean {
    if (!this.target) return false;
    return this.host.driveMateValue(this.target.mateId, value);
  }

  private valueAt(step: number): number {
    const start = parseFloat(this.startInput.value) || 0;
    const end = parseFloat(this.endInput.value) || 0;
    const steps = this.steps();
    return start + (end - start) * (Math.min(step, steps) / steps);
  }

  private steps(): number {
    const n = Math.floor(parseFloat(this.stepsInput.value));
    return Number.isFinite(n) && n >= 1 ? n : 1;
  }

  private playback(): Playback {
    return this.playbackSelect.value === 'loop' ? 'loop' : 'single';
  }

  private renderPlayButton(): void {
    const playing = this.timer !== null;
    this.playButton.innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
    this.playButton.title = playing ? 'Pause' : 'Play';
  }
}

/** One-decimal format that never prints "-0.0". */
function fmt(n: number): string {
  const s = (Math.round(n * 10) / 10).toString();
  return s === '-0' ? '0' : s;
}
