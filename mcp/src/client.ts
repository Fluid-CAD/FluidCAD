// HTTP+WS client against a running FluidCadServer.
//
// Owned by the MCP process, one instance per workspace it talks to. Holds an
// undici Pool keyed by the server's origin and a lazily-opened WebSocket for
// streaming notifications. The future per-instance auth header would land
// here (and only here).

import { Pool, type Dispatcher } from 'undici';
import { WebSocket } from 'ws';
import type { RegistryEntry } from './types.ts';

const HEALTH_PROBE_TIMEOUT_MS = 500;

/** Lifecycle ping for one render pass on the server. */
export type RenderEvent = {
  version: number;
  state: 'start' | 'end' | 'error';
  absPath?: string;
  /** Local monotonic timestamp when the message was received. */
  receivedAt: number;
};

export type IdleResult = {
  idleMs: number;
  lastVersion: number | null;
};

export type HealthResponse = {
  ok: boolean;
  version: string;
  workspacePath: string;
  startedAt: string;
  pid: number;
};

export class FluidCadClient {
  private readonly origin: string;
  private readonly pool: Pool;
  private ws: WebSocket | null = null;
  private wsOpen: Promise<WebSocket> | null = null;
  private closed = false;

  // Render-event tracking. Latest `start` timestamp is kept so wait-for-idle
  // can answer "stable for at least N ms" without re-subscribing each call.
  // Listeners receive every render-version message.
  private lastStartAt: number | null = null;
  private lastStartVersion: number | null = null;
  private renderListeners = new Set<(event: RenderEvent) => void>();
  private wsErrorListeners = new Set<(err: Error) => void>();

  constructor(public readonly entry: RegistryEntry) {
    this.origin = `http://127.0.0.1:${entry.port}`;
    this.pool = new Pool(this.origin, { connections: 4 });
  }

  /** Quick liveness check. Returns null when the server is unreachable. */
  async health(): Promise<HealthResponse | null> {
    try {
      const res = await this.pool.request({
        path: '/api/health',
        method: 'GET',
        bodyTimeout: HEALTH_PROBE_TIMEOUT_MS,
        headersTimeout: HEALTH_PROBE_TIMEOUT_MS,
      });
      if (res.statusCode !== 200) {
        return null;
      }
      const body = await res.body.json() as HealthResponse;
      return body;
    } catch {
      return null;
    }
  }

  async getJson<T>(path: string): Promise<T> {
    const res = await this.pool.request({ path, method: 'GET' });
    return readJsonBody<T>(res);
  }

  async postJson<T>(path: string, body: unknown): Promise<T> {
    const res = await this.pool.request({
      path,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    return readJsonBody<T>(res);
  }

  async postRaw(path: string, body: unknown): Promise<{ statusCode: number; data: Buffer; contentType: string }> {
    const res = await this.pool.request({
      path,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    const chunks: Buffer[] = [];
    for await (const chunk of res.body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const contentType = String(res.headers['content-type'] ?? 'application/octet-stream');
    return { statusCode: res.statusCode, data: Buffer.concat(chunks), contentType };
  }

  async ensureWebSocket(): Promise<WebSocket> {
    if (this.closed) {
      throw new Error('Client is closed.');
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return this.ws;
    }
    if (this.wsOpen) {
      return this.wsOpen;
    }

    const url = `ws://127.0.0.1:${this.entry.port}`;
    const socket = new WebSocket(url);
    this.ws = socket;
    this.wsOpen = new Promise<WebSocket>((resolve, reject) => {
      const onOpen = () => {
        cleanup();
        resolve(socket);
      };
      const onError = (err: Error) => {
        cleanup();
        this.ws = null;
        this.wsOpen = null;
        this.notifyWsError(err);
        reject(err);
      };
      const cleanup = () => {
        socket.off('open', onOpen);
        socket.off('error', onError);
      };
      socket.once('open', onOpen);
      socket.once('error', onError);
    });
    socket.on('message', (raw) => this.handleWsMessage(String(raw)));
    socket.on('close', () => {
      if (this.ws === socket) {
        this.ws = null;
        this.wsOpen = null;
      }
      // Surface a close as an error to anyone currently awaiting events. They
      // can retry; the next call will reconnect lazily.
      this.notifyWsError(new Error('WebSocket closed.'));
    });
    return this.wsOpen;
  }

  /**
   * Wait until `stableMs` has passed since the last observed render `start`.
   * Resolves immediately (with `idleMs = stableMs`) if no `start` has been
   * seen since subscription opened.
   */
  async nextIdle(stableMs: number, timeoutMs: number): Promise<IdleResult> {
    await this.ensureWebSocket();
    return new Promise<IdleResult>((resolve, reject) => {
      const subscribeAt = nowMs();
      let latestStartAt = this.lastStartAt;
      let latestStartVersion = this.lastStartVersion;
      const cleanup = () => {
        clearTimeout(idleTimer);
        clearTimeout(deadlineTimer);
        this.renderListeners.delete(onEvent);
        this.wsErrorListeners.delete(onError);
      };
      const settle = () => {
        cleanup();
        const last = latestStartAt ?? subscribeAt;
        resolve({
          idleMs: Math.max(0, nowMs() - last),
          lastVersion: latestStartVersion,
        });
      };
      const armIdleTimer = (since: number) => {
        clearTimeout(idleTimer);
        const remaining = Math.max(0, stableMs - (nowMs() - since));
        idleTimer = setTimeout(settle, remaining);
      };
      let idleTimer = setTimeout(settle, stableMs);
      const deadlineTimer = setTimeout(() => {
        cleanup();
        reject(new TimeoutError(`Not idle for ${stableMs}ms within ${timeoutMs}ms.`));
      }, timeoutMs);
      const onEvent = (event: RenderEvent) => {
        if (event.state !== 'start') {
          return;
        }
        latestStartAt = event.receivedAt;
        latestStartVersion = event.version;
        armIdleTimer(event.receivedAt);
      };
      const onError = (err: Error) => {
        cleanup();
        reject(new WsError(err.message));
      };
      this.renderListeners.add(onEvent);
      this.wsErrorListeners.add(onError);
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.renderListeners.clear();
    this.wsErrorListeners.clear();
    if (this.ws) {
      this.ws.removeAllListeners('close');
      this.ws.close();
      this.ws = null;
      this.wsOpen = null;
    }
    await this.pool.close();
  }

  private handleWsMessage(raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || msg.type !== 'render-version' || typeof msg.version !== 'number') {
      return;
    }
    const state = msg.state;
    if (state !== 'start' && state !== 'end' && state !== 'error') {
      return;
    }
    const event: RenderEvent = {
      version: msg.version,
      state,
      absPath: typeof msg.absPath === 'string' ? msg.absPath : undefined,
      receivedAt: nowMs(),
    };
    if (state === 'start') {
      this.lastStartAt = event.receivedAt;
      this.lastStartVersion = event.version;
    }
    for (const listener of [...this.renderListeners]) {
      listener(event);
    }
  }

  private notifyWsError(err: Error): void {
    for (const listener of [...this.wsErrorListeners]) {
      listener(err);
    }
  }
}

function nowMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

export class WsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WsError';
  }
}

async function readJsonBody<T>(res: Dispatcher.ResponseData): Promise<T> {
  if (res.statusCode >= 400) {
    const text = await res.body.text();
    throw new HttpError(res.statusCode, text);
  }
  return await res.body.json() as T;
}

export class HttpError extends Error {
  constructor(public readonly statusCode: number, public readonly body: string) {
    super(`HTTP ${statusCode}: ${body.slice(0, 200)}`);
    this.name = 'HttpError';
  }
}
