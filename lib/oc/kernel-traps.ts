/** One trap of the OpenCascade wasm module: what trapped, while doing what. */
export type KernelTrapReport = {
  /** The trap as the runtime reported it: "memory access out of bounds", "unreachable", … */
  message: string;
  /** The type of the scene object whose build trapped (`acme.twist`, `extrude`); null outside a build. */
  type: string | null;
  /** The row's name in the timeline (`Twist`); null outside a build. */
  name: string | null;
  /** What the kernel was doing: a statement's build, a dialog's preview, a render. */
  during: 'build' | 'preview' | 'render';
  /** When it happened, ms since the epoch. */
  at: number;
};

type TrapListener = (report: KernelTrapReport) => void;

/**
 * The OpenCascade kernel's traps: a `WebAssembly.RuntimeError` thrown out of
 * the wasm module — "memory access out of bounds", "unreachable", "table
 * index is out of bounds". A trap is not an OCCT exception (those reach JS
 * as numbers and leave the kernel sound): it means C++ code read or jumped
 * somewhere it never should have, mid-operation. The module itself keeps
 * running, so the statement that trapped fails on its own row and the rest
 * of the model still renders, but the heap may now be corrupt — memory a
 * raw-OpenCascade feature freed twice, or freed from under the scene — and
 * everything the engine builds afterwards is suspect until it restarts.
 *
 * Every trap the engine catches is recorded here, so the host that runs the
 * engine hears of each one ({@link onTrap}) and can say the engine needs a
 * restart. Nothing is ever cleared: only a new process is a sound heap.
 */
export class KernelTraps {
  private static readonly listeners = new Set<TrapListener>();
  private static first: KernelTrapReport | null = null;
  private static count = 0;

  /** Runtime errors only the wasm module throws. */
  private static readonly TRAP_MESSAGES =
    /memory access out of bounds|unreachable|table index is out of bounds|indirect call|call stack exhausted|divide by zero|integer overflow|invalid conversion to integer|null function/i;

  /** Whether `error` is a trap of the wasm module rather than a JavaScript or OCCT error. */
  static isTrap(error: unknown): boolean {
    if (typeof WebAssembly !== 'undefined' && error instanceof WebAssembly.RuntimeError) {
      return true;
    }
    // A RuntimeError from another realm (a worker, a vm context) fails the
    // instanceof; its name and message still say what it is.
    return error instanceof Error && error.name === 'RuntimeError' && KernelTraps.TRAP_MESSAGES.test(error.message);
  }

  /**
   * Record a trap the engine caught, and tell every listener. Returns the
   * report.
   */
  static record(error: unknown, source: { type?: string | null; name?: string | null; during: KernelTrapReport['during'] }): KernelTrapReport {
    const report: KernelTrapReport = {
      message: error instanceof Error ? error.message : String(error),
      type: source.type ?? null,
      name: source.name ?? null,
      during: source.during,
      at: Date.now(),
    };
    KernelTraps.count++;
    KernelTraps.first ??= report;
    for (const listener of [...KernelTraps.listeners]) {
      try {
        listener(report);
      } catch (err) {
        console.error('A kernel trap listener failed:', err);
      }
    }
    return report;
  }

  /** The row error of a statement whose build trapped. */
  static buildMessage(name: string, error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return `${name} crashed the OpenCascade kernel (${message}). The engine's memory may be damaged: `
      + `what it builds from now on is suspect until the engine restarts.`;
  }

  /** Hear of every trap from now on. Returns the unsubscribe. */
  static onTrap(listener: TrapListener): () => void {
    KernelTraps.listeners.add(listener);
    return () => {
      KernelTraps.listeners.delete(listener);
    };
  }

  /** Whether the kernel has trapped since the engine started: its heap may be corrupt. */
  static get suspect(): boolean {
    return KernelTraps.count > 0;
  }

  /** The first trap since the engine started (the likeliest cause of any that followed), or null. */
  static get firstTrap(): KernelTrapReport | null {
    return KernelTraps.first;
  }

  /** How many traps the engine has caught since it started. */
  static get trapCount(): number {
    return KernelTraps.count;
  }
}
