import { app } from 'electron';

/**
 * Shell updates.
 *
 * The shell is the only tier that updates itself, and it can never change
 * geometry: a project keeps running the engine it pins, and the built-in engine
 * that rides along is just another cache entry. That is the update promise, and
 * it is what makes silent background updates acceptable here at all.
 *
 * The model is Chrome's: check quietly at launch and every few hours, download
 * in the background, install whenever the app next quits. Nothing modal. Once a
 * build is staged, the menu grows a "Restart to Update" item for anyone who
 * wants it sooner; everyone else gets it at their next launch without noticing.
 *
 * Every platform self-updates through electron-updater. macOS only allows that
 * for a signed app (Squirrel.Mac refuses to install an unsigned bundle), which
 * the release workflow guarantees since 2026-08-16: builds are signed with a
 * Developer ID and notarized, and `zip` + `latest-mac.yml` ship alongside the
 * dmg for the updater to read. Releases before that were unsigned and ran a
 * notify-and-open-the-download-page path instead; they cannot upgrade in
 * place, their users download the first signed build by hand once. On Linux
 * only the AppImage self-updates; the deb is a package-manager affair and the
 * updater is simply inert there.
 */

/** Chrome checks roughly every five hours; four keeps a day-long session current. */
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

let pendingVersion: string | null = null;
let onStaged: (() => void) | null = null;
let updater: typeof import('electron-updater').autoUpdater | null = null;

/** The version downloaded and waiting for a relaunch, or null. */
export function pendingUpdateVersion(): string | null {
  return pendingVersion;
}

/** Quit and install the staged build; a no-op when nothing is staged. */
export function restartToUpdate(): void {
  if (pendingVersion && updater) {
    updater.quitAndInstall();
  }
}

/**
 * Start silent updates. `onUpdateStaged` fires once a build has been
 * downloaded so the caller can rebuild the menu.
 */
export function initAutoUpdate(onUpdateStaged: () => void): void {
  onStaged = onUpdateStaged;
  if (!app.isPackaged || process.env.FLUIDCAD_DISABLE_UPDATES === '1') {
    return;
  }

  // Imported lazily so a dev run never loads it.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { autoUpdater } = require('electron-updater') as typeof import('electron-updater');
  updater = autoUpdater;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('error', (err) => {
    console.error(`[updater] ${err?.message ?? err}`);
  });

  autoUpdater.on('update-downloaded', (info) => {
    pendingVersion = info.version;
    onStaged?.();
  });

  const check = (): void => {
    // A staged build waits for the relaunch; nothing newer is fetched over it.
    if (pendingVersion) {
      return;
    }
    void autoUpdater.checkForUpdates().catch(() => undefined);
  };

  check();
  const timer = setInterval(check, CHECK_INTERVAL_MS);
  timer.unref();
}
