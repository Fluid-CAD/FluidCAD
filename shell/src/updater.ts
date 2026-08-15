import { app, dialog, shell } from 'electron';

/**
 * Shell updates.
 *
 * The shell is the only tier that updates itself, and it can never change
 * geometry: a project keeps running the engine it pins, and the built-in engine
 * that rides along is just another cache entry. That is the update promise, and
 * it is what makes silent background updates acceptable here at all.
 *
 * **Signing status: none, deliberately (decision 2026-08-14).** That has one
 * hard consequence — macOS refuses to apply an update to an unsigned app, and
 * Squirrel.Mac would fail after downloading. So macOS gets a *notification*
 * update path (check, tell, open the download page) while Windows and Linux
 * self-update through electron-updater. When Developer ID signing and
 * notarization are added, delete `notifyOnly` and let every platform take the
 * `autoUpdater` branch.
 */

const RELEASES_API = 'https://api.github.com/repos/Fluid-CAD/FluidCAD/releases/latest';
const RELEASES_PAGE = 'https://github.com/Fluid-CAD/FluidCAD/releases/latest';

/** Compare `1.2.3`-style versions. Positive when `a` is newer. */
function compareVersions(a: string, b: string): number {
  const left = a.replace(/^v/, '').split('.').map(Number);
  const right = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (Number.isNaN(l) || Number.isNaN(r)) {
      return 0;
    }
    if (l !== r) {
      return l - r;
    }
  }
  return 0;
}

async function notifyOnly(): Promise<void> {
  try {
    const response = await fetch(RELEASES_API, { headers: { accept: 'application/vnd.github+json' } });
    if (!response.ok) {
      return;
    }
    const release = (await response.json()) as { tag_name?: string; name?: string };
    const latest = release.tag_name?.replace(/^v/, '');
    if (!latest || compareVersions(latest, app.getVersion()) <= 0) {
      return;
    }
    const choice = await dialog.showMessageBox({
      type: 'info',
      message: `FluidCAD ${latest} is available.`,
      detail:
        `You are running ${app.getVersion()}. Your projects keep the engine they pin, ` +
        'so updating the app will not change any geometry.',
      buttons: ['Download', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });
    if (choice.response === 0) {
      await shell.openExternal(RELEASES_PAGE);
    }
  } catch {
    // An update check is never worth interrupting anyone over.
  }
}

export function initAutoUpdate(): void {
  if (!app.isPackaged || process.env.FLUIDCAD_DISABLE_UPDATES === '1') {
    return;
  }

  if (process.platform === 'darwin') {
    void notifyOnly();
    return;
  }

  // Imported lazily so a dev run (or a platform that takes the notify-only
  // path) never loads it.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { autoUpdater } = require('electron-updater') as typeof import('electron-updater');

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('error', (err) => {
    console.error(`[updater] ${err?.message ?? err}`);
  });

  autoUpdater.on('update-downloaded', async (info) => {
    const choice = await dialog.showMessageBox({
      type: 'info',
      message: `FluidCAD ${info.version} is ready to install.`,
      detail:
        'Your projects keep the engine they pin, so restarting will not change any geometry.',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });
    if (choice.response === 0) {
      autoUpdater.quitAndInstall();
    }
  });

  void autoUpdater.checkForUpdates();
}
