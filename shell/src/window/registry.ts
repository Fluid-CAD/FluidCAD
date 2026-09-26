import type { WindowPhase } from './window-state';

/**
 * Where an "open this project" request goes. Pure, over a snapshot of the
 * windows, so the table in `docs/desktop/06-phase-4-start-screen-in-ui.md`
 * is tested as written:
 *
 *   already open anywhere                      → focus that window
 *   from a window's start screen               → that window
 *   from the menu, focused window idle         → the focused window
 *   from the menu, focused window busy         → a new window
 *   from the OS (argv, Finder, second launch)  → an idle start screen, else a new window
 *
 * "Idle" is a window on its start screen with nothing opening: `home`, or
 * `failed` for a request made from the window itself. A window that is
 * opening, has failed or shows a project holds that project; opening it again
 * elsewhere would run the same workspace twice.
 */

export type WindowSnapshot = {
  id: number;
  phase: WindowPhase;
  /** The project the window holds, in every phase but home. */
  projectPath: string | null;
  focused: boolean;
};

export type OpenRequest =
  /** A card, Open Project or New Project on the start screen of window `windowId`. */
  | { source: 'start-screen'; windowId: number; path: string }
  /** File › Open Project, Open Recent or New Project: acts on the focused window. */
  | { source: 'menu'; path: string }
  /** A path from the command line, a second launch, or a Finder/Explorer open. */
  | { source: 'os'; path: string };

export type OpenRoute =
  | { action: 'focus'; windowId: number }
  | { action: 'open-in'; windowId: number }
  | { action: 'new-window' };

export function routeOpen(windows: WindowSnapshot[], request: OpenRequest): OpenRoute {
  const holder = windows.find((window) => window.projectPath === request.path);
  if (holder) {
    return { action: 'focus', windowId: holder.id };
  }
  switch (request.source) {
    case 'start-screen': {
      const window = windows.find((candidate) => candidate.id === request.windowId);
      return window && (window.phase === 'home' || window.phase === 'failed')
        ? { action: 'open-in', windowId: window.id }
        : { action: 'new-window' };
    }
    case 'menu': {
      const focused = windows.find((window) => window.focused);
      if (focused) {
        return focused.phase === 'home' || focused.phase === 'failed'
          ? { action: 'open-in', windowId: focused.id }
          : { action: 'new-window' };
      }
      return idleOrNew(windows);
    }
    case 'os':
      return idleOrNew(windows);
  }
}

/** An idle start screen (the focused one first), or a new window. */
function idleOrNew(windows: WindowSnapshot[]): OpenRoute {
  const idle = windows.filter((window) => window.phase === 'home').sort((a, b) => Number(b.focused) - Number(a.focused));
  return idle[0] ? { action: 'open-in', windowId: idle[0].id } : { action: 'new-window' };
}
