import { contextBridge, ipcRenderer } from 'electron';

/**
 * The renderer bridge — two APIs, and which one a page gets is decided by
 * where the page came from:
 *
 * - `file:` pages are the shell's own (the startup splash, the engine
 *   manager). They exist for the moments when there is no engine to talk to
 *   yet, and they get `window.fluidcadShell`.
 * - everything else is the engine's page, served over HTTP from localhost. It
 *   gets `window.fluidcadDesktop`: native gestures the page cannot do for
 *   itself, and nothing more.
 *
 * The split matters. The engine's page is engine-versioned and may be much
 * older than the shell; it must not be able to drive the engine cache. And the
 * same page build runs in a browser tab from `npx fluidcad serve`, where
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
};

const shellApi = {
  onStatus: (handler: (status: unknown) => void): void => {
    ipcRenderer.on('shell:status', (_event, status: unknown) => handler(status));
  },

  retry: (): Promise<void> => ipcRenderer.invoke('shell:retry'),
  openProject: (): Promise<void> => ipcRenderer.invoke('shell:open-project'),

  /** The start screen: recent projects with previews, open, new. */
  start: {
    list: (): Promise<any> => ipcRenderer.invoke('shell:start-list'),
    open: (workspacePath: string): Promise<void> => ipcRenderer.invoke('shell:start-open', workspacePath),
    openDialog: (): Promise<void> => ipcRenderer.invoke('shell:start-open-dialog'),
    newProject: (): Promise<void> => ipcRenderer.invoke('shell:start-new-project'),
    forget: (workspacePath: string): Promise<void> => ipcRenderer.invoke('shell:start-forget', workspacePath),
    /** Tutorials + notifications from the feed worker (cached, offline-safe). */
    feed: (): Promise<any> => ipcRenderer.invoke('shell:start-feed'),
    dismissNotification: (id: string): Promise<void> =>
      ipcRenderer.invoke('shell:start-dismiss-notification', id),
    /** Open an http(s) link in the user's browser. */
    openLink: (url: string): Promise<void> => ipcRenderer.invoke('shell:start-open-link', url),
    /** Grow/shrink the window by this many CSS pixels so the content fits. */
    fitHeight: (delta: number): Promise<void> => ipcRenderer.invoke('shell:start-fit-height', delta),
    /** The recents changed under the page (a project closed, a preview landed). */
    onChanged: (handler: () => void): void => {
      ipcRenderer.on('shell:start-changed', () => handler());
    },
  },

  engines: {
    list: (): Promise<any> => ipcRenderer.invoke('shell:engines-list'),
    remove: (version: string): Promise<any> => ipcRenderer.invoke('shell:engines-remove', version),
    /** Rebuild the project on both engines and report what moved. Commits nothing. */
    previewUpgrade: (workspacePath: string, version: string): Promise<any> =>
      ipcRenderer.invoke('shell:engines-preview-upgrade', workspacePath, version),
    /** Move the pin, after the diff was accepted. */
    applyPin: (workspacePath: string, version: string): Promise<any> =>
      ipcRenderer.invoke('shell:engines-apply-pin', workspacePath, version),
    openProject: (workspacePath: string): Promise<any> =>
      ipcRenderer.invoke('shell:engines-open-project', workspacePath),
    onProgress: (handler: (progress: { message: string }) => void): void => {
      ipcRenderer.on('shell:upgrade-progress', (_event, progress: any) => handler(progress));
    },
  },
};

export type FluidcadDesktopApi = typeof desktopApi;
export type FluidcadShellApi = typeof shellApi;

if (location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('fluidcadShell', shellApi);
} else {
  contextBridge.exposeInMainWorld('fluidcadDesktop', desktopApi);
}
