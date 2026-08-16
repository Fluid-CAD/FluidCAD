import { app, dialog } from 'electron';

/**
 * Shell updates.
 *
 * The shell is the only tier that updates itself, and it can never change
 * geometry: a project keeps running the engine it pins, and the built-in engine
 * that rides along is just another cache entry. That is the update promise, and
 * it is what makes silent background updates acceptable here at all.
 *
 * Every platform self-updates through electron-updater. macOS only allows that
 * for a signed app (Squirrel.Mac refuses to install an unsigned bundle), which
 * the release workflow guarantees since 2026-08-16: builds are signed with a
 * Developer ID and notarized, and `zip` + `latest-mac.yml` ship alongside the
 * dmg for the updater to read. Releases before that were unsigned and ran a
 * notify-and-open-the-download-page path instead; they cannot upgrade in
 * place, their users download the first signed build by hand once.
 */

export function initAutoUpdate(): void {
  if (!app.isPackaged || process.env.FLUIDCAD_DISABLE_UPDATES === '1') {
    return;
  }

  // Imported lazily so a dev run never loads it.
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
