/**
 * Trace output for the per-object and per-shape steps of a render — one line
 * per scene object, per vertex, per face split. A large scene prints tens of
 * thousands of them per render, each formatted and piped to the editor host,
 * so they are off unless the process runs with FLUIDCAD_DEBUG set. Messages a
 * user should see (warnings, one-per-render milestones) stay on `console`.
 */
const enabled = typeof process !== 'undefined' && Boolean(process.env?.FLUIDCAD_DEBUG);

export function debug(...args: unknown[]): void {
  if (enabled) {
    console.log(...args);
  }
}
