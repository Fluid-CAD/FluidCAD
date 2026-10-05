/**
 * How many threads OpenCascade's parallel algorithms (booleans, meshing) may
 * use. The same count sizes the pthread worker pool the kernel starts with,
 * and every worker costs memory whether it is busy or not, so the default
 * stops at MAX_WORKERS_DEFAULT_CAP: past eight, renders measured no faster.
 *
 * Kept free of kernel imports so the server's preferences and the UI's
 * Settings dialog can share the numbers without loading OpenCascade.
 */
export const MAX_WORKERS_DEFAULT_CAP = 8;

/** Logical CPUs of this machine: `navigator.hardwareConcurrency`, in browsers and in Node. */
export function logicalCpuCount(): number {
  const count = globalThis.navigator?.hardwareConcurrency;
  return typeof count === 'number' && count >= 1 ? Math.floor(count) : 1;
}

/** The worker count when none is configured: one per CPU, at most MAX_WORKERS_DEFAULT_CAP. */
export function defaultMaxWorkers(cpus: number = logicalCpuCount()): number {
  return Math.max(1, Math.min(cpus, MAX_WORKERS_DEFAULT_CAP));
}

/** `value` as a usable worker count, a whole number in `[1, cpus]`; null when it is not a number. */
export function clampMaxWorkers(value: unknown, cpus: number = logicalCpuCount()): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  return Math.min(Math.max(1, cpus), Math.max(1, Math.round(value)));
}
