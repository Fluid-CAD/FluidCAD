/**
 * The browser tabs `npx fluidcad` opens projects in: one per project, named
 * after it. A project that is open already is brought forward in its own tab
 * instead of getting a second one (two pages editing one project's files is
 * what the desktop app's "focus the window that has it" avoids too).
 *
 * The tab starts on this same start page, at `/?project=<path>`, which shows
 * the project's progress and then goes to its engine's page. The name is how
 * the browser finds the tab again: `window.open(url, name)` reuses a tab of
 * that name, even once it shows the engine's page from another origin.
 *
 * A browser only lets a page open a tab while it handles the user's gesture,
 * so every call here happens synchronously in the click that asked for it.
 */

/** The start page's URL for the tab `path` opens in; `create` sets a new project up first. */
export function projectTabUrl(path: string, options: { create?: boolean } = {}): string {
  const params = new URLSearchParams({ project: path });
  if (options.create) {
    params.set('create', '1');
  }
  return `/?${params}`;
}

/** The project a tab was opened for, from its URL; null on the start screen itself. */
export function projectOfTab(search: string): { path: string; create: boolean } | null {
  const params = new URLSearchParams(search);
  const path = params.get('project');
  return path ? { path, create: params.get('create') === '1' } : null;
}

/** A stable tab name for a project: FNV-1a of its path, so any length of path makes a short name. */
export function projectTabName(path: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < path.length; i++) {
    hash ^= path.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fluidcad-project-${hash.toString(16).padStart(8, '0')}`;
}

/** Whether `tab` is the blank page a named `window.open('')` makes when no tab of that name exists. */
function isBlank(tab: Window): boolean {
  try {
    return tab.location.href === 'about:blank';
  } catch {
    // Another origin: the project's engine page, in a tab found by its name.
    return false;
  }
}

export class ProjectTabs {
  /** The tabs this page opened or found, to close or reuse them later. */
  private readonly tabs = new Map<string, Window>();

  constructor(private readonly host: Pick<Window, 'open'> & { location: Pick<Location, 'origin'> } = window) {}

  /**
   * Show `path` in its tab. For a project that is `running`, bring its tab
   * forward when there is one; otherwise send the tab — a new one, or a stale
   * one left from before — to the start page for it. False when the browser
   * refused to open a tab.
   */
  show(path: string, options: { running: boolean; create?: boolean }): boolean {
    const name = projectTabName(path);
    const url = new URL(projectTabUrl(path, { create: options.create }), this.host.location.origin).href;
    if (!options.running) {
      const tab = this.host.open(url, name);
      if (!tab) {
        return false;
      }
      this.tabs.set(path, tab);
      return true;
    }
    const tab = this.host.open('', name);
    if (!tab) {
      return false;
    }
    this.tabs.set(path, tab);
    if (isBlank(tab)) {
      tab.location.replace(url);
    } else {
      tab.focus();
    }
    return true;
  }

  /** Close the project's tab, when this page opened it and it is still there. */
  close(path: string): void {
    const tab = this.tabs.get(path);
    this.tabs.delete(path);
    if (tab && !tab.closed) {
      tab.close();
    }
  }

  /**
   * Send the project's tab back to the start page for it, which opens the
   * project again: after its engine changed, its old page must not stay up.
   */
  reopen(path: string): void {
    const tab = this.tabs.get(path);
    if (tab && !tab.closed) {
      tab.location.replace(new URL(projectTabUrl(path), this.host.location.origin).href);
    }
  }
}
