import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../src/server.ts';
import { registryFilePath } from '../src/discovery.ts';
import { waitForIdle, waitForRender } from '../src/tools/coordination.ts';
import type { RegistryEntry } from '../src/types.ts';

let fakeHome: string;
let homeSpy: ReturnType<typeof vi.spyOn>;
let fakeServer: http.Server | null = null;
let wss: WebSocketServer | null = null;
let connectedSockets: Set<WebSocket> = new Set();
let fakePort = 0;

function entry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    workspacePath: '/tmp/ws-mcp-coord',
    port: fakePort,
    pid: process.pid,
    version: '0.0.33',
    startedAt: '2026-05-20T12:00:00.000Z',
    ...overrides,
  };
}

function writeRegistry(entries: RegistryEntry[]): void {
  const dir = path.dirname(registryFilePath());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(registryFilePath(), JSON.stringify({ schemaVersion: 1, instances: entries }));
}

function startFakeServer(): Promise<number> {
  return new Promise((resolve) => {
    fakeServer = http.createServer((req, res) => {
      if (req.url === '/api/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          version: '0.0.33',
          workspacePath: '/tmp/ws-mcp-coord',
          startedAt: 'x',
          pid: process.pid,
        }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
    wss = new WebSocketServer({ server: fakeServer });
    wss.on('connection', (ws) => {
      connectedSockets.add(ws);
      ws.on('close', () => connectedSockets.delete(ws));
    });
    fakeServer.listen(0, '127.0.0.1', () => {
      const addr = fakeServer!.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve(port);
    });
  });
}

/** Broadcast a render-version message to every connected client. */
function emit(msg: { type: 'render-version'; version: number; state: 'start' | 'end' | 'error'; absPath?: string }) {
  const raw = JSON.stringify(msg);
  for (const ws of connectedSockets) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(raw);
    }
  }
}

/** Sleep used to schedule WS messages — drives the fake server's timeline. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeEach(async () => {
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-mcp-coord-test-'));
  homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
  connectedSockets = new Set();
  fakePort = await startFakeServer();
  writeRegistry([entry()]);
});

afterEach(async () => {
  homeSpy.mockRestore();
  fs.rmSync(fakeHome, { recursive: true, force: true });
  for (const ws of connectedSockets) {
    ws.terminate();
  }
  connectedSockets.clear();
  if (wss) {
    await new Promise<void>((resolve) => wss!.close(() => resolve()));
    wss = null;
  }
  if (fakeServer) {
    await new Promise<void>((resolve) => fakeServer!.close(() => resolve()));
    fakeServer = null;
  }
});

describe('wait_for_render', () => {
  it('resolves on the next render-version: end message', async () => {
    setTimeout(() => {
      emit({ type: 'render-version', version: 1, state: 'start' });
      setTimeout(() => emit({ type: 'render-version', version: 1, state: 'end', absPath: '/tmp/x.fluid.js' }), 30);
    }, 20);

    const result = await waitForRender({ timeoutMs: 1000 });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.state).toBe('rendered');
    expect(result.data.version).toBe(1);
    expect(result.data.absPath).toBe('/tmp/x.fluid.js');
    expect(result.data.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('resolves with a compile-error on render-version: error', async () => {
    setTimeout(() => {
      emit({ type: 'render-version', version: 7, state: 'start' });
      setTimeout(() => emit({ type: 'render-version', version: 7, state: 'error', absPath: '/tmp/x.fluid.js' }), 20);
    }, 10);

    const result = await waitForRender({ timeoutMs: 1000 });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe('compile-error');
    expect((result.details as any).version).toBe(7);
  });

  it('rejects with code=timeout when no completion arrives', async () => {
    const result = await waitForRender({ timeoutMs: 150 });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe('timeout');
  });

  it('ignores intermediate start messages and resolves on the matching end', async () => {
    setTimeout(() => {
      emit({ type: 'render-version', version: 1, state: 'start' });
      emit({ type: 'render-version', version: 2, state: 'start' });
      emit({ type: 'render-version', version: 3, state: 'start' });
      setTimeout(() => emit({ type: 'render-version', version: 3, state: 'end' }), 30);
    }, 20);

    const result = await waitForRender({ timeoutMs: 1000 });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.version).toBe(3);
  });

  it('surfaces a ws-error when the connection drops mid-wait', async () => {
    setTimeout(() => {
      for (const ws of connectedSockets) {
        ws.terminate();
      }
    }, 40);

    const result = await waitForRender({ timeoutMs: 1000 });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe('ws-error');
  });

  it('rejects non-positive timeoutMs', async () => {
    const result = await waitForRender({ timeoutMs: 0 });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe('invalid-input');
  });
});

describe('wait_for_idle', () => {
  it('resolves quickly when no renders are happening', async () => {
    const t0 = Date.now();
    const result = await waitForIdle({ stableMs: 100, timeoutMs: 1000 });
    const elapsed = Date.now() - t0;
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.lastVersion).toBeNull();
    expect(elapsed).toBeGreaterThanOrEqual(80);
    expect(elapsed).toBeLessThan(400);
  });

  it('extends the idle window when fresh start messages arrive', async () => {
    let resolved = false;
    const promise = waitForIdle({ stableMs: 100, timeoutMs: 2000 }).then((r) => {
      resolved = true;
      return r;
    });

    // Hit a start at t=50ms — the idle window should reset.
    await sleep(50);
    emit({ type: 'render-version', version: 1, state: 'start' });
    // At t=120ms (70ms after start) it should NOT have resolved yet.
    await sleep(70);
    expect(resolved).toBe(false);
    // After another 80ms (150ms after the start, > stableMs) it should.
    await sleep(80);
    const result = await promise;
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.lastVersion).toBe(1);
  });

  it('rejects when starts keep arriving past timeoutMs', async () => {
    const interval = setInterval(() => {
      emit({ type: 'render-version', version: Math.floor(Date.now() / 10), state: 'start' });
    }, 40);
    try {
      const result = await waitForIdle({ stableMs: 200, timeoutMs: 400 });
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.code).toBe('timeout');
    } finally {
      clearInterval(interval);
    }
  });

  it('rejects when stableMs >= timeoutMs', async () => {
    const result = await waitForIdle({ stableMs: 1000, timeoutMs: 200 });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe('invalid-input');
  });
});

describe('coordination tools (over MCP)', () => {
  it('the two coordination tools are exposed in the tool list', async () => {
    const server = buildServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const tools = await client.listTools();
      const names = new Set(tools.tools.map((t) => t.name));
      expect(names.has('wait_for_render')).toBe(true);
      expect(names.has('wait_for_idle')).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('wait_for_render returns a parseable payload through MCP', async () => {
    setTimeout(() => {
      emit({ type: 'render-version', version: 5, state: 'start' });
      setTimeout(() => emit({ type: 'render-version', version: 5, state: 'end', absPath: '/tmp/y.fluid.js' }), 20);
    }, 10);

    const server = buildServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({
        name: 'wait_for_render',
        arguments: { workspace: '/tmp/ws-mcp-coord', timeoutMs: 1000 },
      });
      expect(result.isError).not.toBe(true);
      const payload = JSON.parse((result.content as any[])[0].text);
      expect(payload.state).toBe('rendered');
      expect(payload.version).toBe(5);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
