import type { BrowserWindow } from 'electron';
import { dialog } from 'electron';
import { BuiltinEngineRetention } from '../../../launcher/src/engine/retention';
import { EngineSession, type EngineStartOptions } from '../../../launcher/src/projects/engine-session';
import type { OpeningStatus } from '../../../launcher/src/start/contract';
import { UpgradePrompt, type UpgradeChoice } from '../upgrade-prompt';

export { OpenCancelledError } from '../../../launcher/src/projects/engine-session';

/**
 * One project's engine, for as long as a window shows the project. The engine
 * itself — setting a new project up, resolving, downloading, starting,
 * stopping, the preview — is the launcher's {@link EngineSession}, shared with
 * `npx fluidcad`. What only a desktop window can do is added here: the
 * upgrade prompt and the crash banner drawn onto the project's page, and a
 * native dialog when a restart fails.
 *
 * The window outlives its engine on purpose (Invariant 4): OCC wasm can abort
 * the process hard, and Monaco's unsaved buffers live in the renderer. So a
 * dead engine gets a banner and a restart button, not a closed window.
 */
export class ProjectSession {
  private readonly engine: EngineSession;
  private readonly upgradePrompt: UpgradePrompt;

  constructor(
    readonly workspacePath: string,
    readonly browserWindow: BrowserWindow,
  ) {
    this.engine = new EngineSession(workspacePath, { onEngineExit: (code, signal) => this.onEngineExit(code, signal) });
    this.upgradePrompt = new UpgradePrompt(this);
  }

  /** The engine's page, once started. */
  get engineUrl(): string | null {
    return this.engine.engineUrl;
  }

  /** See {@link EngineSession.start}. */
  start(signal: AbortSignal, onStatus: (status: OpeningStatus) => void, options: EngineStartOptions = {}): Promise<string> {
    return this.engine.start(signal, onStatus, options);
  }

  /** Once the window shows the engine's page: render something, then offer an upgrade if there is one. */
  async afterLoad(): Promise<void> {
    if (!this.engine.engineUrl) {
      return;
    }
    await this.engine.openLastFile();
    // Only once the model is up: the offer is about geometry the user can see.
    await this.upgradePrompt.offer();
    // Also once the model is up, so the copy never competes with the kernel
    // bring-up. A no-op unless the pin names the engine inside the app.
    BuiltinEngineRetention.ensureInBackground(this.engine.pin);
  }

  /** A button on the upgrade prompt was pressed in this project's page. */
  respondToUpgrade(choice: UpgradeChoice): Promise<void> {
    return this.upgradePrompt.respond(choice);
  }

  /** The start-screen preview, from the live engine. Resolves either way, within the capture's own timeout. */
  async captureThumbnail(): Promise<void> {
    await this.engine.captureThumbnail();
  }

  /** Stop the engine for good. Idempotent; an engine still starting is reaped when it appears. */
  stop(): void {
    this.engine.stop();
  }

  /** Restart the engine on the same port; the page reconnects on its own. */
  async restartEngine(): Promise<void> {
    try {
      const restarted = await this.engine.restart();
      if (!restarted) {
        return;
      }
      this.clearCrashBanner();
      if (!restarted.samePort && this.engine.engineUrl) {
        // The old port was taken in the meantime; a reload is the only way back.
        await this.browserWindow.loadURL(this.engine.engineUrl);
      } else {
        await this.engine.openLastFile();
      }
    } catch (err: any) {
      if (!this.browserWindow.isDestroyed()) {
        void dialog.showMessageBox(this.browserWindow, {
          type: 'error',
          message: 'The FluidCAD engine could not be restarted.',
          detail: err?.message ?? String(err),
        });
      }
    }
  }

  private onEngineExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.browserWindow.isDestroyed()) {
      return;
    }
    const detail = signal ? `signal ${signal}` : `exit code ${code}`;
    void this.showCrashBanner(`The FluidCAD engine stopped (${detail}).`);
  }

  /**
   * Injected into the live page rather than replacing it: navigating away would
   * throw out every unsaved Monaco buffer, which is the one thing a crash must
   * not do.
   */
  private async showCrashBanner(message: string): Promise<void> {
    const script = `
      (() => {
        const id = 'fluidcad-engine-crash-banner';
        document.getElementById(id)?.remove();
        const bar = document.createElement('div');
        bar.id = id;
        bar.style.cssText = 'position:fixed;inset:auto 0 0 0;z-index:2147483647;display:flex;' +
          'gap:12px;align-items:center;justify-content:center;padding:10px 16px;' +
          'font:500 13px/1.4 system-ui,sans-serif;background:#7f1d1d;color:#fff;';
        const text = document.createElement('span');
        text.textContent = ${JSON.stringify(message)} + ' Your open files are safe.';
        const button = document.createElement('button');
        button.textContent = 'Restart engine';
        button.style.cssText = 'padding:4px 12px;border-radius:6px;border:1px solid #fff6;' +
          'background:#fff2;color:#fff;cursor:pointer;font:inherit;';
        button.onclick = () => {
          button.disabled = true;
          button.textContent = 'Restarting…';
          window.fluidcadDesktop?.restartEngine();
        };
        bar.append(text, button);
        document.body.appendChild(bar);
      })();
    `;
    try {
      await this.browserWindow.webContents.executeJavaScript(script);
    } catch {
      // The page may be mid-navigation; the menu still offers a restart.
    }
  }

  private clearCrashBanner(): void {
    void this.browserWindow.webContents
      .executeJavaScript(`document.getElementById('fluidcad-engine-crash-banner')?.remove();`)
      .catch(() => undefined);
  }
}
