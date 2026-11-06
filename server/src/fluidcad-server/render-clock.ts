// RenderClock: where one render's time went, by phase.

/** The phases a render's time is split into (see {@link RenderClock}). */
export type RenderPhase =
  /** Waiting for the engine: renders, scans and ghosts ahead on its lock. */
  | 'wait'
  /** Evaluating the modules: the file, what it imports, every generator's layout. */
  | 'evaluate'
  /** Pairing the new scene with the previous one (what is kept). */
  | 'compare'
  /** The engine's render pass: builds, triangulation and mesh extraction. */
  | 'render'
  /** Reading the rendered rows and the assembly's records off the scene. */
  | 'collect';

/**
 * Where one render's time went, by phase, in milliseconds. Asked for by
 * the renders that answer with timings (an assembly preview, P7); every
 * other render passes none and pays nothing. Two `performance.now()` reads
 * per phase, nothing logged.
 */
export class RenderClock {
  private readonly phases = new Map<RenderPhase, number>();

  /** Add `ms` to `phase`. */
  add(phase: RenderPhase, ms: number): void {
    this.phases.set(phase, (this.phases.get(phase) ?? 0) + ms);
  }

  /** Time `fn` into `phase`; its value (or throw) passes through. */
  time<T>(phase: RenderPhase, fn: () => T): T {
    const start = performance.now();
    try {
      return fn();
    } finally {
      this.add(phase, performance.now() - start);
    }
  }

  /** Time the awaited `fn` into `phase`. */
  async timeAsync<T>(phase: RenderPhase, fn: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try {
      return await fn();
    } finally {
      this.add(phase, performance.now() - start);
    }
  }

  /** The milliseconds `phase` took, 0 when it never ran. */
  get(phase: RenderPhase): number {
    return this.phases.get(phase) ?? 0;
  }

  /** Milliseconds rounded to a tenth, for the wire. */
  static round(ms: number): number {
    return Math.round(ms * 10) / 10;
  }
}
