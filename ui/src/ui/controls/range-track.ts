export interface RangeTrackOptions {
  min: number;
  max: number;
  step: number;
  /** Where the thumb starts; left out, the track claims no value. */
  value?: number;
}

/**
 * A range track: a thumb between two ends, moved in steps. It can claim no
 * value — beside an input that holds something a track cannot show — and
 * then looks disabled while a drag still gives it one.
 */
export class RangeTrack {
  readonly element: HTMLInputElement;

  /** The user moved the thumb. */
  onInput?: (value: number) => void;

  private current: number | undefined;

  constructor(private readonly options: RangeTrackOptions) {
    this.element = document.createElement('input');
    this.element.type = 'range';
    this.element.className = 'range range-xs range-primary w-full';
    this.element.min = String(options.min);
    this.element.max = String(options.max);
    this.element.step = String(options.step);
    this.setValue(options.value);
    this.element.addEventListener('input', () => {
      const value = this.clamp(Number(this.element.value));
      this.place(value);
      this.onInput?.(value);
    });
  }

  /** The value the thumb sits at, or undefined while the track claims none. */
  get value(): number | undefined {
    return this.current;
  }

  /** Put the thumb at `value`, clamped to the ends, without it counting as the user's; undefined claims no value. */
  setValue(value: number | undefined): void {
    this.place(value === undefined || !Number.isFinite(value) ? undefined : this.clamp(value));
  }

  setEnabled(enabled: boolean): void {
    this.element.disabled = !enabled;
  }

  private place(value: number | undefined): void {
    this.current = value;
    if (value !== undefined) {
      this.element.value = String(value);
    }
    this.element.dataset.unset = String(value === undefined);
    this.element.classList.toggle('opacity-40', value === undefined);
  }

  private clamp(value: number): number {
    return Math.min(this.options.max, Math.max(this.options.min, value));
  }
}
