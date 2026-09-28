import path from 'path';
import type { ReopenTarget } from '../engine/upgrade.ts';
import { probeDirtyFiles } from '../projects/dirty-files.ts';
import { EngineSession, OpenCancelledError } from '../projects/engine-session.ts';
import { INITIAL_STATE, projectOf, transition, type OpenEvent, type OpenState } from '../projects/open-state.ts';
import type { ActionResult, OpeningProject, SessionView } from '../start/contract.ts';

/**
 * The projects `npx fluidcad` has open: one engine session per project, each
 * shown in a browser tab of its own.
 *
 * It is the desktop's window, minus the window. The same pure state machine
 * (`projects/open-state.ts`) drives both, and the same {@link EngineSession}
 * resolves, starts and stops the engine. What a browser changes is who
 * watches: the tab a project opens in shows the start page, which follows its
 * session here over the event stream and goes to the engine's page once the
 * session runs. The registry never learns when that tab closes — a browser
 * does not say — so a project's engine runs until it is closed from the start
 * screen or `npx fluidcad` stops.
 *
 * A crashed engine is started again once, on the same port, where its tab
 * reconnects by itself with the editor's unsaved buffers intact. The desktop
 * shows a banner with a Restart button instead; a browser tab has nothing the
 * launcher could draw that on.
 */

/** A crash this soon after the last restart is not restarted again. */
const RESTART_WINDOW_MS = 60_000;

/** A running project's preview is retaken at most this often. */
const PREVIEW_INTERVAL_MS = 30_000;

type Entry = {
  state: OpenState;
  session: EngineSession | null;
  abort: AbortController | null;
  /** Set the project up first, until an open of it has succeeded. */
  create: boolean;
  /** When the engine was last restarted after a crash. */
  restartedAt: number | null;
  /** When the preview was last taken. */
  previewAt: number;
};

export type SessionRegistryHooks = {
  /** A session changed; every page is told, and a project's own tab acts on it. */
  onView(workspacePath: string, view: SessionView): void;
  /** Something the start screens show changed: a project opened, runs now, or closed. */
  changed(): void;
  /** Where an engine's output, and what happens to it, is written. */
  log(project: OpeningProject, line: string, stream: 'stdout' | 'stderr'): void;
};

function projectFor(workspacePath: string): OpeningProject {
  return { path: workspacePath, name: path.basename(workspacePath) };
}

export class SessionRegistry {
  private readonly entries = new Map<string, Entry>();
  private shuttingDown = false;

  constructor(private readonly hooks: SessionRegistryHooks) {}

  /** Opening, failed, or running: a tab holds it. */
  isOpen(workspacePath: string): boolean {
    return this.entries.has(workspacePath);
  }

  view(workspacePath: string): SessionView | null {
    const entry = this.entries.get(workspacePath);
    return entry ? this.viewOf(entry) : null;
  }

  /**
   * Make `workspacePath` run, however far it got: start it, try a failed open
   * again, or restart an engine that stopped. An open already under way is
   * left alone. `create` sets a new project up first. Answers with where the
   * session is now; everything after that arrives through `onView`.
   */
  open(workspacePath: string, options: { create?: boolean } = {}): SessionView {
    if (this.shuttingDown) {
      throw new Error('FluidCAD is stopping.');
    }
    let entry = this.entries.get(workspacePath);
    if (!entry) {
      entry = { state: INITIAL_STATE, session: null, abort: null, create: false, restartedAt: null, previewAt: 0 };
      this.entries.set(workspacePath, entry);
    }
    switch (entry.state.phase) {
      case 'home':
        entry.create = options.create === true;
        this.dispatch(workspacePath, entry, {
          type: 'open',
          project: projectFor(workspacePath),
          status: { step: entry.create ? 'creating' : 'resolving' },
        });
        void this.run(workspacePath, entry);
        break;
      case 'failed':
        entry.create ||= options.create === true;
        this.retryEntry(workspacePath, entry);
        break;
      case 'opening':
        break;
      case 'project':
        if (!entry.session?.alive) {
          void this.restart(workspacePath, entry);
        }
        break;
    }
    return this.viewOf(entry) ?? { phase: 'closed', project: projectFor(workspacePath) };
  }

  /** Try a failed open again. */
  retry(workspacePath: string): void {
    const entry = this.entries.get(workspacePath);
    if (entry) {
      this.retryEntry(workspacePath, entry);
    }
  }

  /** Abandon an open under way, or a failed one; the project is no longer open. */
  cancel(workspacePath: string): void {
    const entry = this.entries.get(workspacePath);
    if (!entry) {
      return;
    }
    if (entry.state.phase === 'opening') {
      entry.abort?.abort();
      entry.session?.stop();
      entry.session = null;
    }
    this.dispatch(workspacePath, entry, { type: 'cancel' });
  }

  /**
   * Close the project: take its preview and stop its engine. Refused while
   * its tab has unsaved changes — there is no dialog to ask about them from
   * here, and the tab is where they can be saved.
   */
  async close(workspacePath: string): Promise<ActionResult> {
    const entry = this.entries.get(workspacePath);
    if (!entry) {
      return { ok: true };
    }
    if (entry.state.phase !== 'project') {
      this.cancel(workspacePath);
      return { ok: true };
    }
    const refusal = await this.unsavedChanges(entry, 'close it');
    if (refusal) {
      return { ok: false, error: refusal };
    }
    await this.teardown(workspacePath, entry);
    return { ok: true };
  }

  /** The running project, for a pin change: it closes, and its tab opens it again on the new pin. */
  reopenTarget(workspacePath: string): ReopenTarget | null {
    const entry = this.entries.get(workspacePath);
    if (!entry || entry.state.phase !== 'project') {
      return null;
    }
    return {
      confirmTeardown: async () => {
        const refusal = await this.unsavedChanges(entry, 'switch');
        if (refusal) {
          throw new Error(refusal);
        }
        return true;
      },
      reopenProject: () => this.teardown(workspacePath, entry),
    };
  }

  /**
   * Retake the previews of running projects, at most every
   * {@link PREVIEW_INTERVAL_MS} each. The start page asks for this when it
   * comes back into view: a browser tab gives no notice before it closes, so
   * this is the last moment a project is reliably on screen. True when a new
   * preview landed.
   */
  async capturePreviews(now: number = Date.now()): Promise<boolean> {
    const due = [...this.entries.values()].filter(
      (entry) => entry.state.phase === 'project' && entry.session?.alive && now - entry.previewAt >= PREVIEW_INTERVAL_MS,
    );
    if (due.length === 0) {
      return false;
    }
    for (const entry of due) {
      entry.previewAt = now;
    }
    const taken = await Promise.all(due.map((entry) => entry.session!.captureThumbnail()));
    const any = taken.some(Boolean);
    if (any) {
      this.hooks.changed();
    }
    return any;
  }

  /** On the way out: every running project's preview, then every engine stopped and gone. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const entries = [...this.entries.values()];
    for (const entry of entries) {
      entry.abort?.abort();
    }
    await Promise.allSettled(
      entries.filter((entry) => entry.state.phase === 'project').map((entry) => entry.session?.captureThumbnail()),
    );
    await Promise.allSettled(entries.map((entry) => entry.session?.stopAndWait()));
    this.entries.clear();
  }

  // -------------------------------------------------------------------------

  private viewOf(entry: Entry): SessionView | null {
    const state = entry.state;
    switch (state.phase) {
      case 'home':
        return null;
      case 'opening':
        return { phase: 'opening', project: state.project, status: state.status };
      case 'failed':
        return { phase: 'failed', project: state.project, message: state.message };
      case 'project': {
        const engine = entry.session?.resolved;
        return {
          phase: 'running',
          project: state.project,
          url: state.url,
          version: engine?.version ?? '',
          source: engine?.source ?? 'builtin',
        };
      }
    }
  }

  /** Apply an event; false when it changed nothing. A session back home is closed and forgotten. */
  private dispatch(workspacePath: string, entry: Entry, event: OpenEvent): boolean {
    const previous = entry.state;
    const next = transition(previous, event);
    if (next === previous) {
      return false;
    }
    entry.state = next;
    if (next.phase === 'home') {
      if (this.entries.get(workspacePath) === entry) {
        this.entries.delete(workspacePath);
      }
      this.hooks.onView(workspacePath, { phase: 'closed', project: projectOf(previous) ?? projectFor(workspacePath) });
    } else {
      this.hooks.onView(workspacePath, this.viewOf(entry)!);
    }
    // Every phase change, as a desktop window does it: the project joins the
    // recents while it opens, so the start screens re-read them once it runs.
    if (next.phase !== previous.phase) {
      this.hooks.changed();
    }
    return true;
  }

  private retryEntry(workspacePath: string, entry: Entry): void {
    if (this.dispatch(workspacePath, entry, { type: 'retry', status: { step: entry.create ? 'creating' : 'resolving' } })) {
      void this.run(workspacePath, entry);
    }
  }

  private async run(workspacePath: string, entry: Entry): Promise<void> {
    const state = entry.state;
    if (state.phase !== 'opening') {
      return;
    }
    const attempt = state.attempt;
    const project = state.project;
    const abort = new AbortController();
    entry.abort = abort;
    const session: EngineSession = new EngineSession(workspacePath, {
      onEngineExit: (code, signal) => void this.onEngineExit(workspacePath, entry, session, code, signal),
      onLog: (line, stream) => this.hooks.log(project, line, stream),
    });
    entry.session = session;
    try {
      const url = await session.start(
        abort.signal,
        (status) => this.dispatch(workspacePath, entry, { type: 'progress', attempt, status }),
        { create: entry.create },
      );
      entry.create = false;
      if (!this.dispatch(workspacePath, entry, { type: 'ready', attempt, url })) {
        // Cancelled, or superseded, while the engine came up.
        session.stop();
        return;
      }
      void session.openLastFile();
    } catch (err: any) {
      session.stop();
      if (entry.session === session) {
        entry.session = null;
      }
      if (!(err instanceof OpenCancelledError)) {
        this.dispatch(workspacePath, entry, { type: 'fail', attempt, message: err?.message ?? String(err) });
      }
    } finally {
      if (entry.abort === abort) {
        entry.abort = null;
      }
    }
  }

  private async onEngineExit(
    workspacePath: string,
    entry: Entry,
    session: EngineSession,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    if (this.shuttingDown || entry.session !== session || entry.state.phase !== 'project') {
      return;
    }
    const project = entry.state.project;
    const detail = signal ? `signal ${signal}` : `exit code ${code}`;
    this.hooks.log(project, `The engine stopped (${detail}).`, 'stderr');
    const now = Date.now();
    if (entry.restartedAt !== null && now - entry.restartedAt < RESTART_WINDOW_MS) {
      // It stopped again right after a restart: whatever it is doing will
      // stop it once more. Leave it for the user to open again.
      session.stop();
      entry.session = null;
      if (this.dispatch(workspacePath, entry, { type: 'reopen' })) {
        this.dispatch(workspacePath, entry, {
          type: 'fail',
          attempt: entry.state.attempt,
          message: `The engine stopped again (${detail}). Open the project to start it once more.`,
        });
      }
      return;
    }
    entry.restartedAt = now;
    await this.restart(workspacePath, entry);
  }

  /** Start the session's engine again, on its old port so its tab reconnects. */
  private async restart(workspacePath: string, entry: Entry): Promise<void> {
    const session = entry.session;
    if (!session || !this.dispatch(workspacePath, entry, { type: 'reopen' })) {
      return;
    }
    const attempt = entry.state.attempt;
    const project = projectOf(entry.state)!;
    const engine = session.resolved;
    if (engine) {
      this.dispatch(workspacePath, entry, {
        type: 'progress',
        attempt,
        status: { step: 'starting', version: engine.version, source: engine.source },
      });
    }
    try {
      const restarted = await session.restart();
      const url = session.engineUrl;
      if (!restarted || !url) {
        throw new Error('The engine could not be started again.');
      }
      if (!this.dispatch(workspacePath, entry, { type: 'ready', attempt, url })) {
        return;
      }
      this.hooks.log(
        project,
        restarted.samePort ? 'Started again; its tab reconnects by itself.' : `Started again at ${url}; reload its tab.`,
        'stdout',
      );
      void session.openLastFile();
    } catch (err: any) {
      session.stop();
      entry.session = null;
      this.dispatch(workspacePath, entry, { type: 'fail', attempt, message: err?.message ?? String(err) });
    }
  }

  /** The preview, then the engine stopped, and the project closed. */
  private async teardown(workspacePath: string, entry: Entry): Promise<void> {
    const session = entry.session;
    await session?.captureThumbnail();
    session?.stop();
    entry.session = null;
    this.dispatch(workspacePath, entry, { type: 'close-project' });
  }

  /** Why the project cannot be torn down right now, or null when nothing would be lost. */
  private async unsavedChanges(entry: Entry, action: 'close it' | 'switch'): Promise<string | null> {
    const project = projectOf(entry.state);
    const url = entry.session?.alive ? entry.session.engineUrl : null;
    if (!project || !url) {
      return null;
    }
    const probe = await probeDirtyFiles(url);
    if (!probe.reachable || probe.files.length === 0) {
      return null;
    }
    const names = probe.files.map((file) => {
      const relative = path.relative(project.path, file.path);
      return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : file.path;
    });
    const listed = names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(', ');
    return `${project.name} has unsaved changes in ${listed}. Save them in its tab, then ${action}.`;
  }
}
