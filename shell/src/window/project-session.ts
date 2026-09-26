import type { BrowserWindow } from 'electron';
import { dialog } from 'electron';
import type { ChildProcess } from 'child_process';
import { EngineDownloadError } from '../engine/download';
import { startEngine, stopEngine, type EngineEvents } from '../engine/process';
import { EngineResolutionError, pinProjectIfNeeded, resolveEngine, type ResolvedEngine } from '../engine/resolver';
import { isFluidScriptFile } from '../file-kind';
import type { OpeningStatus } from '../start/contract';
import { rememberProject } from '../state';
import { captureThumbnail } from '../thumbnails';
import { UpgradePrompt, type UpgradeChoice } from '../upgrade-prompt';

/**
 * One project's engine, for as long as a window shows the project: resolve it
 * (downloading if the pin is not installed), start it as a child process, and
 * everything the window needs from it afterwards — the file to open first,
 * the upgrade offer, a restart after a crash, and the start-screen thumbnail
 * when the project closes.
 *
 * The window outlives its engine on purpose (Invariant 4): OCC wasm can abort
 * the process hard, and Monaco's unsaved buffers live in the renderer. So a
 * dead engine gets a banner and a restart button, not a closed window.
 */

/** Thrown when the open was cancelled; the window already went home, so there is nothing to report. */
export class OpenCancelledError extends Error {
  constructor() {
    super('The open was cancelled.');
    this.name = 'OpenCancelledError';
  }
}

export class ProjectSession {
  private child: ChildProcess | null = null;
  private engine: ResolvedEngine | null = null;
  private port: number | null = null;
  private url: string | null = null;
  private stopped = false;
  private restarting = false;
  private readonly upgradePrompt: UpgradePrompt;

  constructor(
    readonly workspacePath: string,
    readonly browserWindow: BrowserWindow,
  ) {
    this.upgradePrompt = new UpgradePrompt(this);
  }

  /** The engine's page, once started. */
  get engineUrl(): string | null {
    return this.url;
  }

  /**
   * Resolve an engine, pin and remember the project, and start the engine.
   * Resolves with the engine's URL. Rejects with a sentence the user can read,
   * or with {@link OpenCancelledError} after {@link stop} — an engine spawned
   * after a cancel is reaped the moment it appears, never left running.
   */
  async start(signal: AbortSignal, onStatus: (status: OpeningStatus) => void): Promise<string> {
    const cancelled = () => this.stopped || signal.aborted;
    try {
      onStatus({ step: 'resolving' });
      const engine = await resolveEngine(this.workspacePath, {
        signal,
        onDownloadStart: (version) => onStatus({ step: 'downloading', version, receivedBytes: 0, totalBytes: null }),
        onProgress: (progress) =>
          onStatus({
            step: 'downloading',
            version: progress.version,
            receivedBytes: progress.receivedBytes,
            totalBytes: progress.totalBytes,
          }),
      });
      if (cancelled()) {
        throw new OpenCancelledError();
      }
      this.engine = engine;

      const written = pinProjectIfNeeded(this.workspacePath, engine);
      rememberProject(this.workspacePath, written ?? engine.pin);

      onStatus({ step: 'starting', version: engine.version, source: engine.source });
      await this.spawn(engine);
      if (cancelled()) {
        throw new OpenCancelledError();
      }
      return this.url!;
    } catch (err: any) {
      if (err instanceof OpenCancelledError || cancelled()) {
        throw new OpenCancelledError();
      }
      throw new Error(
        err instanceof EngineResolutionError || err instanceof EngineDownloadError
          ? err.message
          : err?.message ?? String(err),
      );
    }
  }

  /** Once the window shows the engine's page: render something, then offer an upgrade if there is one. */
  async afterLoad(): Promise<void> {
    if (!this.url) {
      return;
    }
    await this.openLastFile(this.url);
    // Only once the model is up: the offer is about geometry the user can see.
    await this.upgradePrompt.offer();
  }

  /** A button on the upgrade prompt was pressed in this project's page. */
  respondToUpgrade(choice: UpgradeChoice): Promise<void> {
    return this.upgradePrompt.respond(choice);
  }

  /** The start-screen preview, from the live engine. Resolves either way, within the capture's own timeout. */
  async captureThumbnail(): Promise<void> {
    if (!this.url || !this.child || this.child.exitCode !== null) {
      // No engine, no page worth photographing — keep the previous preview.
      return;
    }
    await captureThumbnail(this.url, this.workspacePath);
  }

  /** Stop the engine for good. Idempotent; an engine still starting is reaped when it appears. */
  stop(): void {
    this.stopped = true;
    if (this.child) {
      stopEngine(this.child);
      this.child = null;
    }
  }

  /** Restart the engine on the same port; the page reconnects on its own. */
  async restartEngine(): Promise<void> {
    if (this.restarting || !this.engine || this.stopped) {
      return;
    }
    this.restarting = true;
    try {
      if (this.child) {
        stopEngine(this.child);
        this.child = null;
      }
      const previousUrl = this.url;
      await this.spawn(this.engine);
      this.clearCrashBanner();
      if (this.url !== previousUrl) {
        // The old port was taken in the meantime; a reload is the only way back.
        await this.browserWindow.loadURL(this.url!);
      } else {
        await this.openLastFile(this.url!);
      }
    } catch (err: any) {
      if (!this.browserWindow.isDestroyed()) {
        void dialog.showMessageBox(this.browserWindow, {
          type: 'error',
          message: 'The FluidCAD engine could not be restarted.',
          detail: err?.message ?? String(err),
        });
      }
    } finally {
      this.restarting = false;
    }
  }

  private async spawn(engine: ResolvedEngine): Promise<void> {
    const events: EngineEvents = {
      onSpawn: (child) => {
        this.child = child;
        if (this.stopped) {
          // Cancelled while the engine was resolving or downloading: an
          // engine nobody will ever look at must not be left running.
          stopEngine(child);
          this.child = null;
        }
      },
      onLog: (line, stream) => {
        // The engine's stdout is the shell's log. Keeping it visible is what
        // makes "it didn't open" diagnosable from a terminal launch.
        if (stream === 'stderr') {
          console.error(`[engine] ${line}`);
        } else {
          console.log(`[engine] ${line}`);
        }
      },
      onExit: (code, signal) => this.onEngineExit(code, signal),
    };
    const started = await startEngine(engine, this.workspacePath, events, { preferredPort: this.port ?? undefined });
    if (this.stopped) {
      stopEngine(started.child);
      this.child = null;
      return;
    }
    this.child = started.child;
    this.port = started.port;
    this.url = started.url;
  }

  /**
   * Render something on open. Which file is the project's business — the
   * engine records the last active tab next to the project — so the shell asks
   * it rather than deciding for itself.
   */
  private async openLastFile(url: string): Promise<void> {
    try {
      const state = await fetch(`${url}/api/workspace/editor-state`).then((r) => r.json());
      const candidate: string | null = state?.activeTab ?? null;
      const target = candidate ?? (await this.firstModel(url));
      if (!target) {
        return;
      }
      await fetch(`${url}/api/files/open`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: target }),
      });
    } catch {
      // A workspace with nothing to open is a legitimate state — the page shows
      // its empty editor and the user creates a file.
    }
  }

  /** The shallowest model (part or assembly file) in the workspace — a first-open fallback. */
  private async firstModel(url: string): Promise<string | null> {
    try {
      const tree = await fetch(`${url}/api/files/tree`).then((r) => r.json());
      const files: { path: string }[] = tree?.files ?? [];
      const models = files
        .filter((entry) => typeof entry.path === 'string' && isFluidScriptFile(entry.path))
        .sort((a, b) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path));
      return models[0]?.path ?? null;
    } catch {
      return null;
    }
  }

  private onEngineExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.stopped || this.restarting || this.browserWindow.isDestroyed()) {
      return;
    }
    this.child = null;
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
