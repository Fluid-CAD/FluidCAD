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
        reject(err);
      };
      const cleanup = () => {
        socket.off('open', onOpen);
        socket.off('error', onError);
      };
      socket.once('open', onOpen);
      socket.once('error', onError);
    });
    socket.on('close', () => {
      if (this.ws === socket) {
        this.ws = null;
        this.wsOpen = null;
      }
    });
    return this.wsOpen;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
      this.wsOpen = null;
    }
    await this.pool.close();
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
