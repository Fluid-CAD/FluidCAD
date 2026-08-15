import { BrowserWindow, dialog, shell } from 'electron';
import type { ChildProcess } from 'child_process';
import path from 'path';
import { EngineDownloadError } from './engine/download';
import { startEngine, stopEngine } from './engine/process';
import { EngineResolutionError, pinProjectIfNeeded, resolveEngine, type ResolvedEngine } from './engine/resolver';
import { rememberProject, rememberWindowBounds, readDesktopState } from './state';

/**
 * One window, one project, one engine child.
 *
 * The window outlives its engine on purpose (Invariant 4): OCC wasm can abort
 * the process hard, and Monaco's unsaved buffers live in the renderer. So a
 * dead engine gets a banner and a restart button, not a closed window.
 */

export type ShellStatus =
  | { phase: 'resolving'; workspacePath: string }
  | { phase: 'downloading'; version: string; receivedBytes: number; totalBytes: number | null }
  | { phase: 'starting'; version: string; source: string }
  | { phase: 'error'; message: string };

const STATIC_DIR = path.join(__dirname, '..', 'static');
const STARTUP_PAGE = path.join(STATIC_DIR, 'startup.html');
/**
 * One preload for both pages. It decides what to expose from the page's own
 * protocol — `file:` is the shell's, http is the engine's — which is what lets
 * a single window go from splash to engine page without recreating itself.
 */
const PRELOAD = path.join(__dirname, 'preload.js');

const windows = new Map<string, ProjectWindow>();

export function findProjectWindow(workspacePath: string): ProjectWindow | undefined {
  return windows.get(workspacePath);
}

export function allProjectWindows(): ProjectWindow[] {
  return [...windows.values()];
}

export function windowFor(browserWindow: BrowserWindow | null): ProjectWindow | undefined {
  if (!browserWindow) {
    return undefined;
  }
  return [...windows.values()].find((entry) => entry.browserWindow === browserWindow);
}

export class ProjectWindow {
  readonly browserWindow: BrowserWindow;
  private child: ChildProcess | null = null;
  private engine: ResolvedEngine | null = null;
  private port: number | null = null;
  private url: string | null = null;
  private stopping = false;
  private restarting = false;

  constructor(readonly workspacePath: string) {
    const bounds = readDesktopState().windowBounds;
    this.browserWindow = new BrowserWindow({
      width: bounds?.width ?? 1440,
      height: bounds?.height ?? 900,
      x: bounds?.x,
      y: bounds?.y,
      title: path.basename(workspacePath),
      backgroundColor: '#1c1c1c',
      show: true,
      webPreferences: {
        preload: PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        // The page is served over HTTP from localhost — nothing here needs a
        // relaxed security posture.
        webSecurity: true,
      },
    });

    windows.set(workspacePath, this);

    this.browserWindow.on('close', () => {
      const bounds = this.browserWindow.getNormalBounds();
      rememberWindowBounds(bounds);
    });

    this.browserWindow.on('closed', () => {
      windows.delete(workspacePath);
      this.stopping = true;
      if (this.child) {
        stopEngine(this.child);
        this.child = null;
      }
    });

    // Links to the docs, the hub, anything external: the OS browser, not a
    // second Electron window with no chrome.
    this.browserWindow.webContents.setWindowOpenHandler(({ url }) => {
      void shell.openExternal(url);
      return { action: 'deny' };
    });
  }

  focus(): void {
    if (this.browserWindow.isMinimized()) {
      this.browserWindow.restore();
    }
    this.browserWindow.focus();
  }

  /** Resolve an engine, start it, and point the window at it. */
  async open(): Promise<void> {
    await this.browserWindow.loadFile(STARTUP_PAGE);
    this.setStatus({ phase: 'resolving', workspacePath: this.workspacePath });

    try {
      const engine = await resolveEngine(this.workspacePath, {
        onDownloadStart: (version) =>
          this.setStatus({ phase: 'downloading', version, receivedBytes: 0, totalBytes: null }),
        onProgress: (progress) =>
          this.setStatus({
            phase: 'downloading',
            version: progress.version,
            receivedBytes: progress.receivedBytes,
            totalBytes: progress.totalBytes,
          }),
      });
      this.engine = engine;

      const written = pinProjectIfNeeded(this.workspacePath, engine);
      rememberProject(this.workspacePath, written ?? engine.pin);

      this.setStatus({ phase: 'starting', version: engine.version, source: engine.source });
      await this.startChild(engine);
    } catch (err: any) {
      const message =
        err instanceof EngineResolutionError || err instanceof EngineDownloadError
          ? err.message
          : err?.message ?? String(err);
      this.setStatus({ phase: 'error', message });
    }
  }

  private async startChild(engine: ResolvedEngine): Promise<void> {
    const started = await startEngine(
      engine,
      this.workspacePath,
      {
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
      },
      { preferredPort: this.port ?? undefined },
    );

    this.child = started.child;
    this.port = started.port;
    this.url = started.url;

    // From here the window hosts the engine's page; the preload switches to
    // the small native bridge on its own, because the protocol changed.
    await this.browserWindow.loadURL(started.url);
    this.browserWindow.setTitle(`${path.basename(this.workspacePath)} — FluidCAD`);
    await this.openLastFile(started.url);
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

  /** The shallowest `.fluid.js` in the workspace — a first-open fallback. */
  private async firstModel(url: string): Promise<string | null> {
    try {
      const tree = await fetch(`${url}/api/files/tree`).then((r) => r.json());
      const files: { path: string }[] = tree?.files ?? [];
      const models = files
        .filter((entry) => typeof entry.path === 'string' && entry.path.endsWith('.fluid.js'))
        .sort((a, b) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path));
      return models[0]?.path ?? null;
    } catch {
      return null;
    }
  }

  private onEngineExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.stopping || this.restarting || this.browserWindow.isDestroyed()) {
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

  /** Restart the engine on the same port; the page reconnects on its own. */
  async restartEngine(): Promise<void> {
    if (this.restarting || !this.engine) {
      return;
    }
    this.restarting = true;
    try {
      if (this.child) {
        stopEngine(this.child);
        this.child = null;
      }
      const engine = this.engine;
      const started = await startEngine(
        engine,
        this.workspacePath,
        {
          onLog: (line, stream) =>
            stream === 'stderr' ? console.error(`[engine] ${line}`) : console.log(`[engine] ${line}`),
          onExit: (code, signal) => this.onEngineExit(code, signal),
        },
        { preferredPort: this.port ?? undefined },
      );
      this.child = started.child;
      this.port = started.port;
      this.clearCrashBanner();
      if (started.url !== this.url) {
        // The old port was taken in the meantime; a reload is the only way back.
        this.url = started.url;
        await this.browserWindow.loadURL(started.url);
      } else {
        await this.openLastFile(started.url);
      }
    } catch (err: any) {
      dialog.showMessageBox(this.browserWindow, {
        type: 'error',
        message: 'The FluidCAD engine could not be restarted.',
        detail: err?.message ?? String(err),
      });
    } finally {
      this.restarting = false;
    }
  }

  /** Tell the page (or the startup splash) about a menu action. */
  sendMenuCommand(command: string, payload?: unknown): void {
    if (!this.browserWindow.isDestroyed()) {
      this.browserWindow.webContents.send('desktop:menu-command', command, payload);
    }
  }

  private setStatus(status: ShellStatus): void {
    if (!this.browserWindow.isDestroyed()) {
      this.browserWindow.webContents.send('shell:status', status);
    }
  }

  close(): void {
    this.stopping = true;
    if (this.child) {
      stopEngine(this.child);
      this.child = null;
    }
    if (!this.browserWindow.isDestroyed()) {
      this.browserWindow.close();
    }
  }

  /** Called on quit: stop the engine without waiting for window teardown. */
  shutdown(): void {
    this.stopping = true;
    if (this.child) {
      stopEngine(this.child);
      this.child = null;
    }
  }
}

/** Open (or focus) a window for `workspacePath`. */
export async function openProjectWindow(workspacePath: string): Promise<ProjectWindow> {
  const existing = windows.get(workspacePath);
  if (existing) {
    existing.focus();
    return existing;
  }
  const created = new ProjectWindow(workspacePath);
  await created.open();
  return created;
}
