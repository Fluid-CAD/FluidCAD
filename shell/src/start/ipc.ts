import { ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { StartApi, StartCallError, textArgument } from '../../../launcher/src/start/api';
import { AppWindow } from '../window/app-window';

/**
 * The shell's side of `window.fluidcadShell.start`. The data and most actions
 * are the launcher's {@link StartApi}, which `npx fluidcad` serves over HTTP
 * too; the calls that concern a window — its state, opening, native dialogs —
 * are the shell's own.
 *
 * Every handler answers only the start screen — the main frame of an app
 * window showing the start page or its fallback
 * ({@link AppWindow.forStartScreenSender}); any other sender gets a rejection.
 * Arguments are checked too, by the start API and here: the page is trusted
 * because of where it comes from, and this is what keeps that true.
 */

export type StartScreenIpcDeps = {
  api: StartApi;
  /** Open `workspacePath` for a request made on `window`'s start screen (it may focus another window instead). */
  openFromStartScreen(window: AppWindow, workspacePath: string, options?: { create?: boolean }): void;
  /** The native folder picker, as a sheet on `window`. */
  promptForProject(window: AppWindow): Promise<string | null>;
  /** The native New Project dialog, as a sheet on `window`: the folder to set a project up in, or null. */
  promptForNewProject(window: AppWindow): Promise<{ path: string; create: boolean } | null>;
};

function handle(channel: string, answer: (window: AppWindow, ...args: unknown[]) => unknown): void {
  ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
    const window = AppWindow.forStartScreenSender(event);
    if (!window) {
      throw new StartCallError(`${channel} answers only the start screen.`);
    }
    return answer(window, ...args);
  });
}

export function registerStartScreenIpc(deps: StartScreenIpcDeps): void {
  const { api } = deps;

  handle('shell:start-hello', (window, protocol) => {
    const reply = api.hello(protocol);
    window.helloReceived(reply.ok);
    return reply;
  });

  handle('shell:start-window-state', (window) => window.pageState());
  handle('shell:start-cancel-open', (window) => window.cancelOpen());
  handle('shell:start-retry-open', (window) => window.retryOpen());
  handle('shell:start-appearance', () => api.appearance());

  handle('shell:start-list', () => api.list());
  handle('shell:start-feed', () => api.feed());
  handle('shell:start-dismiss-notification', (_window, id) => api.dismissNotification(id));

  handle('shell:start-open', (window, workspacePath) => {
    deps.openFromStartScreen(window, textArgument(workspacePath, 'a project path'));
  });

  handle('shell:start-open-dialog', async (window) => {
    const picked = await deps.promptForProject(window);
    if (picked) {
      deps.openFromStartScreen(window, picked);
    }
  });

  handle('shell:start-new-project', async (window) => {
    const picked = await deps.promptForNewProject(window);
    if (picked) {
      deps.openFromStartScreen(window, picked.path, { create: picked.create });
    }
  });

  // The window holding the project closes it as File › Close Project would,
  // asking about unsaved buffers itself; the answer here is only that it was asked.
  handle('shell:start-close', (_window, workspacePath) => {
    AppWindow.holding(textArgument(workspacePath, 'a project path'))?.closeProjectCommand();
    return { ok: true };
  });

  handle('shell:start-forget', (_window, workspacePath) => api.forget(workspacePath));

  handle('shell:start-open-link', (_window, url) => {
    // The page's sanitizer already enforces this; keep the main process just as picky.
    if (typeof url === 'string' && /^https?:\/\//.test(url)) {
      void shell.openExternal(url);
    }
  });

  handle('shell:start-engine-options', (_window, workspacePath) => api.engineOptions(workspacePath));

  handle('shell:start-preview-upgrade', (window, workspacePath, target) =>
    api.previewUpgrade(workspacePath, target, (progress) => window.sendUpgradeProgress(progress)),
  );

  handle('shell:start-apply-pin', (_window, workspacePath, target) => api.applyPin(workspacePath, target));
}
