import { compareVersionsDescending } from './download';

/**
 * The compatibility floor between shell and engine.
 *
 * The seam between them is deliberately tiny — the shell spawns a child process
 * and loads one URL (Invariant 3) — but "tiny" is only honest if it is stated.
 * The shell declares the engine range it can host; the engine declares a shell
 * protocol version over `/api/health`. An out-of-range pair is refused with a
 * message, never run and hoped for.
 *
 * This mirrors `VIEWER_PROTOCOL_VERSION` in `lib/browser/types.ts`, which does
 * the same job between the engine and the viewer page.
 */

/** Bumped when the shell↔engine contract changes in a way an engine can detect. */
export const SHELL_PROTOCOL_VERSION = 1;

/**
 * The first engine that can be hosted: P1-1/P1-2 landed `/api/files` and the
 * WebSocket host transport in 0.0.41, and without them the window has an editor
 * with nothing behind it.
 */
export const MIN_ENGINE = '0.0.41';

/** Open-ended: a newer engine is assumed to keep serving the same page. */
export const MAX_ENGINE: string | null = null;

/** Returns a message when `version` cannot be hosted, or null when it can. */
export function describeEngineIncompatibility(version: string): string | null {
  if (compareVersionsDescending(version, MIN_ENGINE) > 0) {
    return (
      `This project pins FluidCAD engine ${version}, which this app cannot run — ` +
      `it hosts ${MIN_ENGINE} and newer. Open the project with ` +
      '`npx fluidcad@' + version + ' serve`, or upgrade the pin.'
    );
  }
  if (MAX_ENGINE && compareVersionsDescending(MAX_ENGINE, version) > 0) {
    return (
      `This project pins FluidCAD engine ${version}, which is newer than this ` +
      `app supports (up to ${MAX_ENGINE}). Update FluidCAD and try again.`
    );
  }
  return null;
}
