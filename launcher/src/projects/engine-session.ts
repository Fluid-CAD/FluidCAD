import type { ChildProcess } from 'child_process';
import { EngineDownloadError } from '../engine/download.ts';
import { startEngine, stopEngine, type EngineEvents } from '../engine/process.ts';
import { EngineResolutionError, pinProjectIfNeeded, resolveEngine, type ResolvedEngine } from '../engine/resolver.ts';
import { isFluidScriptFile } from '../file-kind.ts';
import { captureThumbnail } from '../previews/thumbnails.ts';
import type { OpeningStatus } from '../start/contract.ts';
import { rememberProject } from './app-state.ts';
import { ScaffoldError, scaffoldProject } from './scaffold.ts';

/**
 * One project's engine, for as long as a launcher shows the project: set the
 * project up if it is new, resolve its engine (downloading if the pin is not
 * installed), start it as a child process, and everything needed from it
 * afterwards — the file to render first, a restart after a crash, and the
 * start-screen preview.
 *
 * The desktop app wraps one of these per window (`shell/src/window/
 * project-session.ts`, which adds the crash banner and the upgrade prompt it
 * draws onto the page); `npx fluidcad` keeps one per project it opened in a
 * tab (`server/session-registry.ts`).
 *
 * Whatever shows the project outlives its engine on purpose (Invariant 4):
 * OCC wasm can abort the process hard, and Monaco's unsaved buffers live in
 * the page. A dead engine is restarted on the same port, where the page
 * reconnects by itself.
 */

/** Thrown when the open was cancelled; whoever cancelled it has already moved on, so there is nothing to report. */
export class OpenCancelledError extends Error {
  constructor() {
    super('The open was cancelled.');
    this.name = 'OpenCancelledError';
  }
}

export type EngineSessionEvents = {
  /** The engine stopped on its own once it was up: a crash, or a kill from outside. */
  onEngineExit?(code: number | null, signal: NodeJS.Signals | null): void;
  /** The engine's output; the console by default, where a terminal launch shows it. */
  onLog?(line: string, stream: 'stdout' | 'stderr'): void;
};

export type EngineStartOptions = {
  /** Set the project up first (`fluidcad init`), unless its folder already holds one. */
  create?: boolean;
  /** Start on this port when it is free, so a page left from an earlier engine finds the new one. */
  preferredPort?: number;
};

function logToConsole(line: string, stream: 'stdout' | 'stderr'): void {
  if (stream === 'stderr') {
    console.error(`[engine] ${line}`);
  } else {
    console.log(`[engine] ${line}`);
  }
}

export class EngineSession {
  private child: ChildProcess | null = null;
  private engine: ResolvedEngine | null = null;
  /** The engine version the project pins once opened: the pin it had, or the one written for it. */
  private pinned: string | null = null;
  private boundPort: number | null = null;
  private url: string | null = null;
  private stopped = false;
  private restarting = false;

  constructor(
    readonly workspacePath: string,
    private readonly events: EngineSessionEvents = {},
  ) {}

  /** The engine's page, once started. */
  get engineUrl(): string | null {
    return this.url;
  }

  get pin(): string | null {
    return this.pinned;
  }

  get port(): number | null {
    return this.boundPort;
  }

  /** The engine this session resolved, once it has. */
  get resolved(): ResolvedEngine | null {
    return this.engine;
  }

  /** True while an engine process is up. */
  get alive(): boolean {
    return this.child !== null && this.child.exitCode === null && this.child.signalCode === null;
  }

  /**
   * Set up, resolve, pin, remember and start. Resolves with the engine's URL.
   * Rejects with a sentence the user can read, or with
   * {@link OpenCancelledError} after {@link stop} — an engine spawned after a
   * cancel is reaped the moment it appears, never left running.
   */
  async start(
    signal: AbortSignal,
    onStatus: (status: OpeningStatus) => void,
    options: EngineStartOptions = {},
  ): Promise<string> {
    const cancelled = () => this.stopped || signal.aborted;
    try {
      if (options.create) {
        onStatus({ step: 'creating' });
        await scaffoldProject(this.workspacePath);
        if (cancelled()) {
          throw new OpenCancelledError();
        }
      }

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
      this.pinned = written ?? engine.pin;
      rememberProject(this.workspacePath, this.pinned);

      onStatus({ step: 'starting', version: engine.version, source: engine.source });
      await this.spawn(engine, options.preferredPort);
      if (cancelled()) {
        throw new OpenCancelledError();
      }
      return this.url!;
    } catch (err: any) {
      if (err instanceof OpenCancelledError || cancelled()) {
        throw new OpenCancelledError();
      }
      throw new Error(
        err instanceof EngineResolutionError || err instanceof EngineDownloadError || err instanceof ScaffoldError
          ? err.message
          : err?.message ?? String(err),
      );
    }
  }

  /**
   * Render something on open. Which file is the project's business — the
   * engine records the last active tab next to the project — so the launcher
   * asks it rather than deciding for itself.
   */
  async openLastFile(): Promise<void> {
    const url = this.url;
    if (!url) {
      return;
    }
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

  /** The start-screen preview, from the live engine. Resolves either way, within the capture's own timeout. */
  async captureThumbnail(): Promise<boolean> {
    if (!this.url || !this.alive) {
      // No engine, no page worth photographing — keep the previous preview.
      return false;
    }
    return captureThumbnail(this.url, this.workspacePath);
  }

  /** Stop the engine for good. Idempotent; an engine still starting is reaped when it appears. */
  stop(): void {
    this.stopped = true;
    if (this.child) {
      stopEngine(this.child);
      this.child = null;
    }
  }

  /**
   * {@link stop}, then wait for the engine to be gone — killing it after
   * `graceMs` — so a launcher that is quitting does not exit ahead of the
   * engine's own cleanup (its instance file and registry entry).
   */
  async stopAndWait(graceMs = 3_000): Promise<void> {
    const child = this.child;
    this.stop();
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, graceMs);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /**
   * Start the engine again, on its old port when that is still free — the
   * page reconnects its socket on its own then, and Monaco's unsaved buffers
   * survive. Resolves with whether the port was kept — a page on another port
   * must be reloaded to find the new engine — or with null when there was
   * nothing to restart: never started, stopped for good, or already restarting.
   */
  async restart(): Promise<{ samePort: boolean } | null> {
    if (this.restarting || !this.engine || this.stopped) {
      return null;
    }
    this.restarting = true;
    try {
      if (this.child) {
        stopEngine(this.child);
        this.child = null;
      }
      const previousUrl = this.url;
      await this.spawn(this.engine, this.boundPort ?? undefined);
      return { samePort: this.url === previousUrl };
    } finally {
      this.restarting = false;
    }
  }

  private async spawn(engine: ResolvedEngine, preferredPort: number | undefined): Promise<void> {
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
      // The engine's output is the launcher's log. Keeping it visible is what
      // makes "it didn't open" diagnosable from a terminal launch.
      onLog: this.events.onLog ?? logToConsole,
      onExit: (code, signal) => this.onEngineExit(code, signal),
    };
    const started = await startEngine(engine, this.workspacePath, events, { preferredPort });
    if (this.stopped) {
      stopEngine(started.child);
      this.child = null;
      return;
    }
    this.child = started.child;
    this.boundPort = started.port;
    this.url = started.url;
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
    if (this.stopped || this.restarting) {
      return;
    }
    this.child = null;
    this.events.onEngineExit?.(code, signal);
  }
}
