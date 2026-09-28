/**
 * Where an "open this project" request goes. Pure, over a snapshot of the
 * windows:
 *
 *   already open anywhere  → focus that window
 *   anything else          → a new window
 *
 * Every project gets a window of its own, whether it is asked for from a
 * window's start screen, the File menu, or the OS (the command line, a second
 * launch, Finder or Explorer): the start screen a request came from stays
 * where it is, the way `npx fluidcad` opens each project in a tab of its own
 * and leaves its start screen open. "Already open" counts a window that is
 * opening the project or failed to: opening it again elsewhere would run the
 * same workspace twice.
 */

export type WindowSnapshot = {
  id: number;
  /** The project the window holds, in every phase but home. */
  projectPath: string | null;
};

export type OpenRoute = { action: 'focus'; windowId: number } | { action: 'new-window' };

export function routeOpen(windows: WindowSnapshot[], projectPath: string): OpenRoute {
  const holder = windows.find((window) => window.projectPath === projectPath);
  return holder ? { action: 'focus', windowId: holder.id } : { action: 'new-window' };
}

/**
 * What a window does once it no longer holds its project — Close Project, a
 * cancelled open, Back to projects after a failure: it goes, since its
 * project was all it was for, unless it is the app's last window. That one
 * shows the start screen instead, so there is always a way back to the
 * projects.
 */
export function afterProject(windowCount: number): 'close-window' | 'show-start-screen' {
  return windowCount > 1 ? 'close-window' : 'show-start-screen';
}
