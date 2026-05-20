import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../src/server.ts';
import { registryFilePath } from '../src/discovery.ts';
import {
  getCompileError,
  getEdgeProperties,
  getFaceProperties,
  getSceneSummary,
  getShapeProperties,
  hitTest,
  listShapes,
  resolveClient,
} from '../src/tools/inspection.ts';
import type { RegistryEntry } from '../src/types.ts';

let fakeHome: string;
let homeSpy: ReturnType<typeof vi.spyOn>;
let fakeServer: http.Server | null = null;
let fakePort: number = 0;
let lastRequest: { method: string; url: string; body: string } | null = null;

function entry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    workspacePath: '/tmp/ws-mcp-inspect',
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

/** Stand-in for FluidCadServer that records each request and answers with
 *  a canned payload — keeps these tests free of OCC dependencies. */
function startFakeServer(routes: Record<string, (req: http.IncomingMessage, body: string) => { status: number; body: any } | null>): Promise<number> {
  return new Promise((resolve) => {
    fakeServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        lastRequest = { method: req.method ?? '', url: req.url ?? '', body };
        const url = (req.url ?? '').split('?')[0];
        if (url === '/api/health') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, version: '0.0.33', workspacePath: '/tmp/ws-mcp-inspect', startedAt: 'x', pid: process.pid }));
          return;
        }
        const handler = routes[url];
        if (!handler) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'not found' }));
          return;
        }
        const result = handler(req, body);
        if (!result) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'no result' }));
          return;
        }
        res.writeHead(result.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(result.body));
      });
    });
    fakeServer.listen(0, '127.0.0.1', () => {
      const addr = fakeServer!.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve(port);
    });
  });
}

beforeEach(() => {
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-mcp-inspect-test-'));
  homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
  lastRequest = null;
});

afterEach(async () => {
  homeSpy.mockRestore();
  fs.rmSync(fakeHome, { recursive: true, force: true });
  if (fakeServer) {
    await new Promise<void>((resolve) => fakeServer!.close(() => resolve()));
    fakeServer = null;
  }
});

describe('resolveClient', () => {
  it('returns no-server when no instances are running', () => {
    const result = resolveClient({});
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe('no-server');
  });

  it('returns workspace-not-found when the requested workspace is missing', async () => {
    fakePort = await startFakeServer({});
    writeRegistry([entry()]);
    const result = resolveClient({ workspace: '/tmp/nonexistent' });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe('workspace-not-found');
  });

  it('returns no-workspace when multiple instances are running and none specified', async () => {
    fakePort = await startFakeServer({});
    writeRegistry([
      entry({ workspacePath: '/tmp/ws-a' }),
      entry({ workspacePath: '/tmp/ws-b', port: fakePort + 1 }),
    ]);
    const result = resolveClient({});
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe('no-workspace');
  });

  it('uses the singleton when only one instance is running', async () => {
    fakePort = await startFakeServer({});
    writeRegistry([entry()]);
    const result = resolveClient({});
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.entry.workspacePath).toBe('/tmp/ws-mcp-inspect');
    await result.data.client.close();
  });
});

describe('inspection tools (unit)', () => {
  beforeEach(async () => {
    fakePort = await startFakeServer({
      '/api/scene/summary': () => ({
        status: 200,
        body: {
          schemaVersion: 1,
          file: '/tmp/ws-mcp-inspect/part.fluid.js',
          objects: [
            { index: 0, id: 'obj-12', kind: 'sketch', name: 'outer', params: { plane: 'xy' }, shapeIds: ['sh-1'], fromCache: false, hasError: false, containerId: null },
            { index: 1, id: 'obj-13', kind: 'extrude', name: 'Extrude', params: { distance: 30 }, shapeIds: ['sh-2'], fromCache: false, hasError: false, containerId: null },
          ],
          rollbackStop: 1,
          compileError: null,
        },
      }),
      '/api/scene/shapes': () => ({
        status: 200,
        body: {
          shapes: [
            { shapeId: 'sh-1', type: 'Sketch', sceneObjectId: 'obj-12' },
            { shapeId: 'sh-2', type: 'Solid', sceneObjectId: 'obj-13' },
          ],
        },
      }),
      '/api/scene/compile-error': () => ({
        status: 200,
        body: { compileError: null },
      }),
      '/api/shape-properties': () => ({ status: 200, body: { volume: 150000 } }),
      '/api/face-properties': () => ({ status: 200, body: { area: 5000 } }),
      '/api/edge-properties': () => ({ status: 200, body: { length: 100 } }),
      '/api/hit-test': () => ({ status: 200, body: { type: 'face', index: 3 } }),
    });
    writeRegistry([entry()]);
  });

  it('get_scene_summary resolves the workspace and returns the payload', async () => {
    const result = await getSceneSummary({});
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect((result.data as any).schemaVersion).toBe(1);
    expect((result.data as any).objects.length).toBe(2);
  });

  it('list_shapes returns the flat shape list', async () => {
    const result = await listShapes({});
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect((result.data as any).shapes).toHaveLength(2);
  });

  it('get_compile_error returns null when there is none', async () => {
    const result = await getCompileError({});
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect((result.data as any).compileError).toBeNull();
  });

  it('get_shape_properties forwards shapeId in the query string', async () => {
    const result = await getShapeProperties({ shapeId: 'sh-1' });
    expect(result.ok).toBe(true);
    expect(lastRequest?.url).toBe('/api/shape-properties?shapeId=sh-1');
  });

  it('get_shape_properties rejects empty shapeId', async () => {
    const result = await getShapeProperties({ shapeId: '' as string });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe('invalid-input');
  });

  it('get_face_properties forwards shapeId and faceIndex', async () => {
    const result = await getFaceProperties({ shapeId: 'sh-2', faceIndex: 4 });
    expect(result.ok).toBe(true);
    expect(lastRequest?.url).toBe('/api/face-properties?shapeId=sh-2&faceIndex=4');
  });

  it('get_face_properties rejects negative faceIndex', async () => {
    const result = await getFaceProperties({ shapeId: 'sh-2', faceIndex: -1 });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe('invalid-input');
  });

  it('get_edge_properties forwards shapeId and edgeIndex', async () => {
    const result = await getEdgeProperties({ shapeId: 'sh-2', edgeIndex: 7 });
    expect(result.ok).toBe(true);
    expect(lastRequest?.url).toBe('/api/edge-properties?shapeId=sh-2&edgeIndex=7');
  });

  it('hit_test posts ray data and defaults edgeThreshold to 0', async () => {
    const result = await hitTest({
      shapeId: 'sh-2',
      rayOrigin: [0, 0, 100],
      rayDir: [0, 0, -1],
    });
    expect(result.ok).toBe(true);
    expect(lastRequest?.method).toBe('POST');
    expect(lastRequest?.url).toBe('/api/hit-test');
    const body = JSON.parse(lastRequest!.body);
    expect(body.shapeId).toBe('sh-2');
    expect(body.rayOrigin).toEqual([0, 0, 100]);
    expect(body.edgeThreshold).toBe(0);
  });

  it('hit_test rejects non-numeric ray vectors', async () => {
    const result = await hitTest({
      shapeId: 'sh-2',
      rayOrigin: ['a', 0, 0] as any,
      rayDir: [0, 0, -1],
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe('invalid-input');
  });
});

describe('inspection tools (over MCP)', () => {
  it('the MCP client sees all seven inspection tools', async () => {
    const server = buildServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const tools = await client.listTools();
      const names = new Set(tools.tools.map((t) => t.name));
      for (const expected of [
        'get_scene_summary',
        'list_shapes',
        'get_compile_error',
        'get_shape_properties',
        'get_face_properties',
        'get_edge_properties',
        'hit_test',
      ]) {
        expect(names.has(expected)).toBe(true);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('get_scene_summary resolves through FluidCadClient and returns a parseable payload', async () => {
    fakePort = await startFakeServer({
      '/api/scene/summary': () => ({
        status: 200,
        body: {
          schemaVersion: 1,
          file: '/tmp/ws-mcp-inspect/part.fluid.js',
          objects: [],
          rollbackStop: -1,
          compileError: null,
        },
      }),
    });
    writeRegistry([entry()]);

    const server = buildServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({
        name: 'get_scene_summary',
        arguments: { workspace: '/tmp/ws-mcp-inspect' },
      });
      expect(result.isError).not.toBe(true);
      const payload = JSON.parse((result.content as any[])[0].text);
      expect(payload.schemaVersion).toBe(1);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('get_scene_summary surfaces workspace-not-found as a tool error', async () => {
    const server = buildServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({
        name: 'get_scene_summary',
        arguments: { workspace: '/tmp/does-not-exist' },
      });
      expect(result.isError).toBe(true);
      const payload = JSON.parse((result.content as any[])[0].text);
      expect(['workspace-not-found', 'no-server']).toContain(payload.code);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
