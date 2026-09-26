import { contextBridge, ipcRenderer } from 'electron';

/**
 * The renderer bridge — two APIs, and which one a page gets is decided by
 * where the page came from:
 *
 * - `fluidcad-app:` is the start screen, rendered by the engine that ships
 *   with the app and served by the shell; `file:` is the shell's own fallback
 *   page for when that one cannot be used. They get `window.fluidcadShell`:
 *   the recents, the feed, opening projects, moving a project's engine.
 * - `http:` is an engine's page, served from localhost by whichever engine the
 *   project pins. It gets `window.fluidcadDesktop`: native gestures the page
 *   cannot do for itself, and nothing more.
 *
 * The split matters more now that one window shows both kinds of page in turn.
 * An engine's page is engine-versioned and may be much older than the shell;
 * it must never reach the engine cache or open projects. Main checks every
 * `shell:start-*` call's sender as well, and cancels any navigation a page
 * starts, so the split holds even for a page that tried to get around it.
 * The same engine page runs in a browser tab from `npx fluidcad serve`, where
 * `window.fluidcadDesktop` is simply undefined — so the page treats every one
 * of these as optional.
 */

export type OpenDialogRequest = {
  title?: string;
  defaultPath?: string;
  filters?: { name: string; extensions: string[] }[];
  properties?: ('openFile' | 'openDirectory' | 'multiSelections' | 'createDirectory')[];
};

export type SaveDialogRequest = {
  title?: string;
  defaultPath?: string;
  filters?: { name: string; extensions: string[] }[];
};

const desktopApi = {
  /** Marks the page as running inside the desktop app. */
  isDesktop: true as const,
  platform: process.platform,

  showOpenDialog: (request: OpenDialogRequest): Promise<string[] | null> =>
    ipcRenderer.invoke('desktop:show-open-dialog', request),

  showSaveDialog: (request: SaveDialogRequest): Promise<string | null> =>
    ipcRenderer.invoke('desktop:show-save-dialog', request),

  /** Write bytes the page produced to a path the user chose. */
  writeFile: (filePath: string, base64: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('desktop:write-file', filePath, base64),

  /** Read a file the user picked, for STEP/STL import. */
  readFile: (filePath: string): Promise<{ ok: boolean; base64?: string; error?: string }> =>
    ipcRenderer.invoke('desktop:read-file', filePath),

  showItemInFolder: (filePath: string): void => {
    void ipcRenderer.invoke('desktop:show-item-in-folder', filePath);
  },

  setTitle: (title: string): void => {
    void ipcRenderer.invoke('desktop:set-title', title);
  },

  /** Native menu items the page is responsible for acting on. */
  onMenuCommand: (handler: (command: string, payload?: unknown) => void): void => {
    ipcRenderer.on('desktop:menu-command', (_event, command: string, payload?: unknown) =>
      handler(command, payload),
    );
  },

  /** Restart the engine behind this window (offered by the crash banner). */
  restartEngine: (): Promise<void> => ipcRenderer.invoke('desktop:restart-engine'),

  /**
   * The engine-upgrade prompt's buttons. The card is the shell's own, drawn
   * onto the page; the page cannot pick a version — it can only hand back
   * which of the shell's buttons was pressed, and the shell validates that.
   */
  engineUpgrade: {
    respond: (choice: string): Promise<void> => ipcRenderer.invoke('desktop:engine-upgrade-respond', choice),
  },
};

/**
 * `window.fluidcadShell.start` — the start screen's contract with the shell.
 * The page's side, with the types and the runtime guards every reply goes
 * through, is `ui/src/start/host.ts`; `tests/start-contract.test.ts` keeps the
 * two in step.
 */
const startApi = {
  hello: (protocol: number): Promise<unknown> => ipcRenderer.invoke('shell:start-hello', protocol),
  windowState: (): Promise<unknown> => ipcRenderer.invoke('shell:start-window-state'),
  onWindowState: (handler: (state: unknown) => void): void => {
    ipcRenderer.on('shell:window-state', (_event, state: unknown) => handler(state));
  },
  cancelOpen: (): Promise<void> => ipcRenderer.invoke('shell:start-cancel-open'),
  retryOpen: (): Promise<void> => ipcRenderer.invoke('shell:start-retry-open'),
  appearance: (): Promise<unknown> => ipcRenderer.invoke('shell:start-appearance'),

  list: (): Promise<unknown> => ipcRenderer.invoke('shell:start-list'),
  /** Tutorials + notifications from the feed worker (cached, offline-safe). */
  feed: (): Promise<unknown> => ipcRenderer.invoke('shell:start-feed'),
  dismissNotification: (id: string): Promise<void> => ipcRenderer.invoke('shell:start-dismiss-notification', id),

  open: (workspacePath: string): Promise<void> => ipcRenderer.invoke('shell:start-open', workspacePath),
  openDialog: (): Promise<void> => ipcRenderer.invoke('shell:start-open-dialog'),
  newProject: (): Promise<void> => ipcRenderer.invoke('shell:start-new-project'),
  forget: (workspacePath: string): Promise<void> => ipcRenderer.invoke('shell:start-forget', workspacePath),
  /** Open an http(s) link in the user's browser. */
  openLink: (url: string): Promise<void> => ipcRenderer.invoke('shell:start-open-link', url),

  /** The "Change engine version…" dialog: what a project can move to. */
  engineOptions: (workspacePath: string): Promise<unknown> => ipcRenderer.invoke('shell:start-engine-options', workspacePath),
  /** Rebuild the project on both engines and report what moved. Commits nothing. */
  previewUpgrade: (workspacePath: string, version: string): Promise<unknown> =>
    ipcRenderer.invoke('shell:start-preview-upgrade', workspacePath, version),
  /** Move the pin; an open project is reopened on it in its own window. */
  applyPin: (workspacePath: string, version: string): Promise<unknown> =>
    ipcRenderer.invoke('shell:start-apply-pin', workspacePath, version),
  onUpgradeProgress: (handler: (progress: unknown) => void): void => {
    ipcRenderer.on('shell:upgrade-progress', (_event, progress: unknown) => handler(progress));
  },
  /** The recents changed under the page (a project closed, a preview landed). */
  onChanged: (handler: () => void): void => {
    ipcRenderer.on('shell:start-changed', () => handler());
  },
};

const shellApi = { start: startApi };

export type FluidcadDesktopApi = typeof desktopApi;
export type FluidcadShellApi = typeof shellApi;

if (location.protocol === 'fluidcad-app:' || location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('fluidcadShell', shellApi);
} else if (location.protocol === 'http:') {
  contextBridge.exposeInMainWorld('fluidcadDesktop', desktopApi);
}
