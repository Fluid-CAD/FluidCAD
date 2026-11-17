// One `codex app-server` child (docs/agent-chat-plan.md §5.2): spawned in
// the project folder, no shell, JSON-RPC over stdio. It serves every chat
// session of the engine, each as its own thread; notifications are routed to
// the thread they name. Every server request is declined (server-requests.ts)
// and the thread it concerns is told.

import { spawn, type ChildProcess } from 'node:child_process';
import { trackChild } from '../children.ts';
import { JsonRpcClosedError, JsonRpcConnection, type JsonRpcNotification, type JsonRpcServerRequest, type ServerRequestAnswer } from './json-rpc.ts';
import { declineServerRequest } from './server-requests.ts';

const INITIALIZE_TIMEOUT_MS = 30_000;
const CLOSE_GRACE_MS = 3_000;
const KILL_GRACE_MS = 2_000;
const STDERR_TAIL_CHARS = 4_000;
/** Notifications kept for a thread not yet attached (they can come before the `thread/start` answer). */
const MAX_ORPHANS_PER_THREAD = 500;
const MAX_ORPHAN_THREADS = 32;

/** What a thread of this server hears. */
export interface ThreadListener {
  onNotification(message: JsonRpcNotification): void;
  /** Codex sent a request about this thread; it was declined, and this says what it was. */
  onDeclinedRequest(notice: string): void;
  /** The server exited; `message` says how, with the tail of its stderr. */
  onServerExit(message: string): void;
}

export type AppServerOptions = {
  path: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** FluidCAD's version, for `clientInfo`. */
  clientVersion: string;
};

export class CodexAppServer {
  readonly rpc: JsonRpcConnection;
  readonly path: string;
  private readonly child: ChildProcess;
  private readonly threads = new Map<string, ThreadListener>();
  private readonly orphans = new Map<string, JsonRpcNotification[]>();
  private stderrTail = '';
  private exitedValue = false;
  private readonly exitPromise: Promise<void>;
  private readonly exitListeners: (() => void)[] = [];

  private constructor(child: ChildProcess, path: string) {
    this.child = child;
    this.path = path;
    this.rpc = new JsonRpcConnection((line) => this.write(line), {
      onNotification: (message) => this.onNotification(message),
      onServerRequest: (message) => this.onServerRequest(message),
    });
    child.stdin?.on('error', () => {
      // EPIPE when the process is gone; the exit handler reports it.
    });
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => this.rpc.pushChunk(chunk));
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
    });
    this.exitPromise = new Promise((resolve) => {
      child.once('close', (code, signal) => {
        this.onExit(code, signal);
        resolve();
      });
    });
    child.on('error', (e) => {
      this.stderrTail = (this.stderrTail + `\n${e.message}`).slice(-STDERR_TAIL_CHARS);
    });
  }

  /** Spawns the server and completes the handshake. */
  static async start(options: AppServerOptions): Promise<CodexAppServer> {
    const child = spawn(options.path, ['app-server'], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => resolve());
      child.once('error', (e) => reject(new Error(`Codex could not be started: ${e.message}`)));
    });
    trackChild(child);
    const server = new CodexAppServer(child, options.path);
    try {
      await server.rpc.request(
        'initialize',
        { clientInfo: { name: 'fluidcad', title: 'FluidCAD', version: options.clientVersion }, capabilities: null },
        INITIALIZE_TIMEOUT_MS,
      );
      server.rpc.notify('initialized');
    } catch (e) {
      await server.close();
      const tail = server.stderrTail.trim();
      throw new Error(`Codex's app server did not start: ${e instanceof Error ? e.message : String(e)}${tail ? `\n${lastLines(tail, 12)}` : ''}`);
    }
    return server;
  }

  get exited(): boolean {
    return this.exitedValue;
  }

  get threadCount(): number {
    return this.threads.size;
  }

  onExitOnce(listener: () => void): void {
    if (this.exitedValue) {
      listener();
      return;
    }
    this.exitListeners.push(listener);
  }

  /** Routes a thread's notifications to `listener`, starting with those that came before it attached. */
  attach(threadId: string, listener: ThreadListener): void {
    this.threads.set(threadId, listener);
    const early = this.orphans.get(threadId) ?? [];
    this.orphans.delete(threadId);
    for (const message of early) {
      listener.onNotification(message);
    }
  }

  detach(threadId: string, listener: ThreadListener): void {
    if (this.threads.get(threadId) === listener) {
      this.threads.delete(threadId);
    }
  }

  /** Ends the server: stdin closed, then SIGTERM, then SIGKILL. */
  async close(): Promise<void> {
    if (this.exitedValue) {
      return;
    }
    this.child.stdin?.end();
    if (await this.waitForExit(CLOSE_GRACE_MS)) {
      return;
    }
    this.child.kill('SIGTERM');
    if (await this.waitForExit(KILL_GRACE_MS)) {
      return;
    }
    this.child.kill('SIGKILL');
    await this.waitForExit(KILL_GRACE_MS);
  }

  private write(line: string): void {
    if (!this.exitedValue) {
      this.child.stdin?.write(line);
    }
  }

  private onNotification(message: JsonRpcNotification): void {
    const threadId = typeof message.params?.threadId === 'string' ? message.params.threadId : null;
    if (threadId === null) {
      // Account-wide (rate limits, login, config warnings): every thread may use it.
      for (const listener of [...this.threads.values()]) {
        listener.onNotification(message);
      }
      return;
    }
    const listener = this.threads.get(threadId);
    if (listener) {
      listener.onNotification(message);
      return;
    }
    let list = this.orphans.get(threadId);
    if (!list) {
      if (this.orphans.size >= MAX_ORPHAN_THREADS) {
        const oldest = this.orphans.keys().next().value;
        if (oldest !== undefined) {
          this.orphans.delete(oldest);
        }
      }
      list = [];
      this.orphans.set(threadId, list);
    }
    list.push(message);
    if (list.length > MAX_ORPHANS_PER_THREAD) {
      list.shift();
    }
  }

  private onServerRequest(message: JsonRpcServerRequest): ServerRequestAnswer {
    const declined = declineServerRequest(message);
    const threadId = typeof message.params?.threadId === 'string' ? message.params.threadId : null;
    if (declined.notice) {
      const listener = threadId ? this.threads.get(threadId) : undefined;
      if (listener) {
        listener.onDeclinedRequest(declined.notice);
      } else {
        console.warn(`[agent] declined a Codex request (${message.method}) for no known thread.`);
      }
    }
    return declined.answer;
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.rpc.flush();
    this.exitedValue = true;
    const tail = this.stderrTail.trim();
    const how = signal ? `was stopped (${signal})` : `exited with code ${code}`;
    const message = `Codex ${how}.${tail ? `\n${lastLines(tail, 12)}` : ''}`;
    this.rpc.close(new JsonRpcClosedError(message));
    const listeners = [...this.threads.values()];
    this.threads.clear();
    this.orphans.clear();
    for (const listener of listeners) {
      listener.onServerExit(message);
    }
    for (const listener of this.exitListeners.splice(0)) {
      listener();
    }
  }

  private waitForExit(ms: number): Promise<boolean> {
    if (this.exitedValue) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(this.exitedValue), ms);
      void this.exitPromise.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
}

function lastLines(text: string, count: number): string {
  return text.split('\n').slice(-count).join('\n');
}
