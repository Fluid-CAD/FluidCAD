import path from 'path';
import { listRecentProjects } from '../../launcher/src/projects/app-state';

/**
 * Since Electron 43 a file dialog given no `defaultPath` opens in Downloads,
 * and the OS no longer remembers the folder between dialogs. Each dialog
 * starts where the last one finished instead, or — before any has run this
 * session — beside the most recently opened project.
 */
let lastDirectory: string | null = null;

/**
 * Where a dialog asked for `requested` should open, given the folder it would
 * start in. A full path is kept as asked; a bare file name (a save dialog's
 * suggestion) is placed in `start`.
 */
export function dialogDefaultPath(requested: string | undefined, start: string | null): string | undefined {
  if (!start) {
    return requested;
  }
  if (!requested) {
    return start;
  }
  return path.basename(requested) === requested ? path.join(start, requested) : requested;
}

function startDirectory(): string | null {
  if (lastDirectory) {
    return lastDirectory;
  }
  const recent = listRecentProjects()[0];
  return recent ? path.dirname(recent.path) : null;
}

/** `options` with its `defaultPath` resolved against the folder the last dialog finished in. */
export function inLastDirectory<T extends { defaultPath?: string }>(options: T): T {
  const defaultPath = dialogDefaultPath(options.defaultPath, startDirectory());
  return defaultPath === undefined ? options : { ...options, defaultPath };
}

/** Remember the folder holding what a dialog returned: a picked folder's parent, a file's directory. */
export function rememberDirectory(picked: string | null | undefined): void {
  if (picked) {
    lastDirectory = path.dirname(picked);
  }
}
