import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../src/server.ts';
import { registryFilePath } from '../src/discovery.ts';
import type { RegistryEntry } from '../src/types.ts';

let fakeHome: string;
let homeSpy: ReturnType<typeof vi.spyOn>;
let healthServer: http.Server | null = null;

function entry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    workspacePath: '/tmp/ws-a',
    port: 3847,
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

// Start a tiny HTTP server that pretends to be FluidCadServer for the health probe.
function startFakeHealthServer(): Promise<number> {
  return new Promise((resolve) => {
    healthServer = http.createServer((req, res) => {
      if (req.url === '/api/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, version: '0.0.33', workspacePath: '/tmp/ws-a', startedAt: 'x', pid: process.pid }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    healthServer.listen(0, '127.0.0.1', () => {
      const addr = healthServer!.address();
      if (typeof addr === 'object' && addr) {
        resolve(addr.port);
      } else {
        resolve(0);
      }
    });
  });
}

beforeEach(() => {
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-mcp-server-test-'));
  homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
});

afterEach(async () => {
  homeSpy.mockRestore();
  fs.rmSync(fakeHome, { recursive: true, force: true });
  if (healthServer) {
    await new Promise<void>((resolve) => healthServer!.close(() => resolve()));
    healthServer = null;
  }
});

describe('MCP server', () => {
  it('lists registered tools, including list_workspaces', async () => {
    const server = buildServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name);
      expect(names).toContain('list_workspaces');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('list_workspaces returns the live entries with reachability', async () => {
    const port = await startFakeHealthServer();
    writeRegistry([
      entry({ workspacePath: '/tmp/ws-reachable', port, pid: process.pid }),
      entry({ workspacePath: '/tmp/ws-unreachable', port: 1, pid: process.pid }),
    ]);

    const server = buildServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({ name: 'list_workspaces', arguments: {} });
      expect(result.isError).not.toBe(true);
      const text = (result.content as any[])[0].text as string;
      const payload = JSON.parse(text);
      const byPath = new Map<string, any>(payload.workspaces.map((w: any) => [w.workspacePath, w]));
      expect(byPath.get('/tmp/ws-reachable')?.reachable).toBe(true);
      expect(byPath.get('/tmp/ws-unreachable')?.reachable).toBe(false);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
