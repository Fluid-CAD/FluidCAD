import { app, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import os from 'os';
import { EngineUpgrade } from '../engine-upgrade';
import { FeedService } from '../feed';
import { createNewProject } from '../new-project';
import { dismissedNotificationIds, dismissNotification, forgetProject } from '../state';
import { AppWindow } from '../window/app-window';
import { helloReply } from './contract';
import { engineOptionsFor, listStartProjects } from './projects';
import { readSavedTheme } from './theme';

/**
 * The shell's side of `window.fluidcadShell.start`. Every handler answers only
 * the start screen — the main frame of an app window showing the start page
 * or its fallback ({@link AppWindow.forStartScreenSender}); any other sender
 * gets a rejection. Arguments are checked here too: the page is trusted
 * because of where it comes from, and this is what keeps that true.
 */

export type StartScreenIpcDeps = {
  /** Open `workspacePath` for a request made on `window`'s start screen (it may focus another window instead). */
  openFromStartScreen(window: AppWindow, workspacePath: string): void;
  /** The native folder picker, as a sheet on `window`. */
  promptForProject(window: AppWindow): Promise<string | null>;
};

/** A version the dialog may pin: the release shape, nothing else reaches `fluidcad.json`. */
const VERSION_SHAPE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

class StartScreenCallError extends Error {}

function text(value: unknown, what: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new StartScreenCallError(`Expected ${what} as a non-empty string.`);
  }
  return value;
}

function version(value: unknown): string {
  const checked = text(value, 'a version');
  if (!VERSION_SHAPE.test(checked)) {
    throw new StartScreenCallError(`"${checked}" is not an engine version.`);
  }
  return checked;
}

function handle(channel: string, answer: (window: AppWindow, ...args: unknown[]) => unknown): void {
  ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
    const window = AppWindow.forStartScreenSender(event);
    if (!window) {
      throw new StartScreenCallError(`${channel} answers only the start screen.`);
    }
    return answer(window, ...args);
  });
}

export function registerStartScreenIpc(deps: StartScreenIpcDeps): void {
  handle('shell:start-hello', (window, protocol) => {
    const reply = helloReply(protocol, { version: app.getVersion(), platform: process.platform, home: os.homedir() });
    window.helloReceived(reply.ok);
    return reply;
  });

  handle('shell:start-window-state', (window) => window.pageState());
  handle('shell:start-cancel-open', (window) => window.cancelOpen());
  handle('shell:start-retry-open', (window) => window.retryOpen());
  handle('shell:start-appearance', () => ({ theme: readSavedTheme() }));

  handle('shell:start-list', () => listStartProjects((workspacePath) => AppWindow.holding(workspacePath) !== undefined));

  /** Tutorials + notifications from the feed worker, minus what was dismissed. */
  handle('shell:start-feed', async () => {
    const feed = await FeedService.load();
    const dismissed = new Set(dismissedNotificationIds());
    return { ...feed, notifications: feed.notifications.filter((entry) => !dismissed.has(entry.id)) };
  });

  handle('shell:start-dismiss-notification', (_window, id) => {
    dismissNotification(text(id, 'a notification id'));
  });

  handle('shell:start-open', (window, workspacePath) => {
    deps.openFromStartScreen(window, text(workspacePath, 'a project path'));
  });

  handle('shell:start-open-dialog', async (window) => {
    const picked = await deps.promptForProject(window);
    if (picked) {
      deps.openFromStartScreen(window, picked);
    }
  });

  handle('shell:start-new-project', async (window) => {
    const outcome = await createNewProject(window.browserWindow);
    if (outcome) {
      deps.openFromStartScreen(window, outcome.path);
    }
  });

  handle('shell:start-forget', (_window, workspacePath) => {
    forgetProject(text(workspacePath, 'a project path'));
    // Every start screen, and Open Recent.
    AppWindow.changed();
  });

  handle('shell:start-open-link', (_window, url) => {
    // The page's sanitizer already enforces this; keep the main process just as picky.
    if (typeof url === 'string' && /^https?:\/\//.test(url)) {
      void shell.openExternal(url);
    }
  });

  handle('shell:start-engine-options', (_window, workspacePath) => engineOptionsFor(text(workspacePath, 'a project path')));

  handle('shell:start-preview-upgrade', (window, workspacePath, target) => {
    const project = text(workspacePath, 'a project path');
    return EngineUpgrade.preview(project, version(target), (message) =>
      window.sendUpgradeProgress({ workspacePath: project, message }),
    );
  });

  handle('shell:start-apply-pin', async (_window, workspacePath, target) => {
    const result = await EngineUpgrade.apply(text(workspacePath, 'a project path'), version(target), {
      openWindowFor: (project) => AppWindow.showing(project) ?? null,
    });
    AppWindow.changed();
    return result;
  });
}
