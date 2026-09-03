// Animate bar — drives a 1-DOF mate (revolute angle / slider travel)
// from a start value to an end value in N steps, once or looping.
//
// Opened from a joint row's "Animate…" menu entry. Two stacked chips at
// the bottom-center of the scene — the fields card over the transport
// pill. The drag readout sits one row above them during a pointer drag;
// the two never show together: driving a mate refuses while a drag owns
// the assembly, and a drag can't start from the bar's inputs. The bar carries no mate label: the selected joints row
// and the mate highlight already say which mate is animating. Values are
// in the readout's units — degrees / mm, the same numbers `.limits()`
// takes — and the unit suffixes the Start and End captions.
//
// Narrow screens (under Tailwind's `lg`): the chips sit one row above the
// scale bar and unit chips that own the bottom edge, and the fields wrap
// onto a second row inside a card that never exceeds the scene's width.
// Each caption sits above its field at every width, so a row stays short.
//
// Manual test plan:
//  1. Right-click a revolute row → Animate… → bar appears with Start 0°,
//     End 360°, Playback Loop; a slider row seeds Start = current value,
//     End = +10 mm, Single. Authored `.limits(min, max)` seed Start/End
//     for both.
//  2. Play → the follower sweeps start→end over `Steps` frames; Single
//     stops at the end, Loop restarts from Start (a whole-turn sweep skips
//     the Start frame, which the End frame already showed, so the seam
//     never holds), Reciprocate bounces (start→end→start…) — both until Stop.
//  3. Play toggles to Pause mid-sweep; Stop returns the part to where it
//     was when the bar opened. × closes the bar (stopping first).
//  4. Edit Start/End while paused → next Play restarts from Start.

import { ICON_CLOSE, ICON_PAUSE, ICON_PLAY, ICON_STOP } from './icons';
import { sceneUnit } from '../units/scene-unit';
import type { MateReadout } from '../solver';

const STEP_INTERVAL_MS = 40;
const DEFAULT_STEPS = 30;
/** A revolute with no authored limits animates one full turn. */
const DEFAULT_ANGLE_SWEEP = 360;
/** A slider with no authored limits travels this far (document units) from where it is. */
const DEFAULT_TRAVEL = 10;

/** The shared chip surface: the fields card and the transport pill. */
const CHIP = 'panel-bg border border-base-content/10';
/** A captioned field: a small caption stacked above its input. */
const FIELD = 'flex flex-col gap-0.5 whitespace-nowrap';
const CAPTION = 'text-base-content/50 text-[10px] leading-none';

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
  kind: MateReadout['kind'];
  /** Authored `.limits(min, max)`, used to seed Start/End. */
  limits?: [number, number];
}

type Playback = 'single' | 'loop' | 'reciprocate';

export class AnimateBar {
  private bar: HTMLDivElement;
  private unitSuffixes: HTMLSpanElement[];
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
    // Two stacked chips — the fields card, then the transport pill — in a
    // column centered on the scene rather than the window (the panel rail
    // and the editor pane take real width off the left) and capped to the
    // scene's width so a narrow screen wraps the fields instead of clipping
    // them. Under `lg` the scale bar and unit chips would meet the column
    // in the bottom row, so it sits one row up there.
    this.bar.className = 'absolute bottom-6 max-lg:bottom-[68px] left-[calc(50%+var(--fluidcad-scene-left,0px)/2)] -translate-x-1/2 z-[115] '
      + 'w-max max-w-[calc(100%-var(--fluidcad-scene-left,0px)-1rem)] '
      + 'flex flex-col items-center gap-1.5 text-xs text-base-content/80 select-none cursor-default hidden';
    this.bar.innerHTML = `
      <span class="${CHIP} rounded-2xl px-3 py-1.5 flex items-end flex-wrap justify-center gap-x-3 gap-y-1.5">
        <label class="${FIELD}"><span class="${CAPTION}">Start <span data-ref="unit"></span></span><input data-ref="start" type="number" step="any" class="input input-xs input-bordered w-[4.5rem] sm:w-20 tabular-nums" /></label>
        <label class="${FIELD}"><span class="${CAPTION}">End <span data-ref="unit"></span></span><input data-ref="end" type="number" step="any" class="input input-xs input-bordered w-[4.5rem] sm:w-20 tabular-nums" /></label>
        <label class="${FIELD}"><span class="${CAPTION}">Steps</span><input data-ref="steps" type="number" min="1" step="1" class="input input-xs input-bordered w-14 sm:w-16 tabular-nums" /></label>
        <label class="${FIELD}"><span class="${CAPTION}">Playback</span>
          <select data-ref="playback" class="select select-xs select-bordered w-28">
            <option value="single">Single</option>
            <option value="loop">Loop</option>
            <option value="reciprocate">Reciprocate</option>
          </select>
        </label>
      </span>
      <span class="${CHIP} rounded-full px-2 py-1 flex items-center gap-1.5">
        <button data-ref="play" class="btn btn-ghost btn-square btn-sm [&>svg]:size-5" title="Play"></button>
        <button data-ref="stop" class="btn btn-ghost btn-square btn-sm [&>svg]:size-5" title="Stop"></button>
        <button data-ref="close" class="btn btn-ghost btn-square btn-sm text-base-content/50 [&>svg]:size-5" title="Close"></button>
      </span>
    `;
    container.appendChild(this.bar);

    const ref = <T extends HTMLElement>(name: string) => this.bar.querySelector<T>(`[data-ref="${name}"]`)!;
    this.unitSuffixes = Array.from(this.bar.querySelectorAll<HTMLSpanElement>('[data-ref="unit"]'));
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
    const isAngle = target.kind === 'angle';
    const unit = isAngle ? '°' : sceneUnit.current;
    for (const suffix of this.unitSuffixes) {
      suffix.textContent = unit;
    }
    // Authored limits win. Otherwise a revolute sweeps a full turn from 0,
    // looping; a slider steps a short travel from where it is, once.
    const { start, end } = target.limits
      ? { start: target.limits[0], end: target.limits[1] }
      : isAngle
        ? { start: 0, end: DEFAULT_ANGLE_SWEEP }
        : { start: current?.value ?? 0, end: (current?.value ?? 0) + DEFAULT_TRAVEL };
    this.startInput.value = fmt(start);
    this.endInput.value = fmt(end);
    this.stepsInput.value = String(DEFAULT_STEPS);
    this.playbackSelect.value = isAngle ? 'loop' : 'single';
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
    const playback = this.playback();
    if (playback === 'single') {
      if (this.step >= steps) {
        this.pause();
        return;
      }
      this.step += 1;
    } else if (playback === 'loop') {
      // Restart after the End frame has shown. When End is the same pose
      // as Start (an angle sweep of whole turns) the Start frame would
      // repeat the End frame — a one-step hold at the seam — so the loop
      // skips straight to the first step past it and keeps its cadence.
      this.step = this.step >= steps ? (this.endMeetsStart() ? 1 : 0) : this.step + 1;
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

  /** Loop seam: an angle sweep spanning whole turns ends where it starts. */
  private endMeetsStart(): boolean {
    if (this.target?.kind !== 'angle') return false;
    const start = parseFloat(this.startInput.value) || 0;
    const end = parseFloat(this.endInput.value) || 0;
    const turns = (end - start) / 360;
    return Math.abs(turns - Math.round(turns)) < 1e-9;
  }

  private steps(): number {
    const n = Math.floor(parseFloat(this.stepsInput.value));
    return Number.isFinite(n) && n >= 1 ? n : 1;
  }

  private playback(): Playback {
    const v = this.playbackSelect.value;
    return v === 'loop' || v === 'reciprocate' ? v : 'single';
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
