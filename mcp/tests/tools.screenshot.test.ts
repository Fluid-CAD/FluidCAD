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
  getCameraState,
  screenshot,
  screenshotMulti,
  screenshotShape,
} from '../src/tools/screenshot.ts';
import type { RegistryEntry } from '../src/types.ts';

// Smallest valid PNG: 1×1 transparent pixel.
const ONE_PIXEL_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63000100000005000100' +
    '0d0a2db40000000049454e44ae426082',
  'hex',
);

let fakeHome: string;
let homeSpy: ReturnType<typeof vi.spyOn>;
let fakeServer: http.Server | null = null;
let fakePort = 0;
let lastRequest: { method: string; url: string; body: string } | null = null;

function entry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    workspacePath: '/tmp/ws-mcp-shot',
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

function startFakeServer(
  routes: Record<
    string,
    (req: http.IncomingMessage, body: string) => { status: number; contentType: string; body: Buffer | string } | null
  >,
): Promise<number> {
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
          res.end(
            JSON.stringify({
              ok: true,
              version: '0.0.33',
              workspacePath: '/tmp/ws-mcp-shot',
              startedAt: 'x',
              pid: process.pid,
            }),
          );
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
        res.writeHead(result.status, { 'content-type': result.contentType });
        res.end(result.body);
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
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-mcp-shot-test-'));
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

describe('screenshot tools (unit)', () => {
  it('rejects an invalid view kind without contacting the server', async () => {
    fakePort = await startFakeServer({
      '/api/screenshot': () => ({ status: 200, contentType: 'image/png', body: ONE_PIXEL_PNG }),
    });
    writeRegistry([entry()]);

    const result = await screenshot({ view: { kind: 'unknown' as any } });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe('invalid-input');
    expect(lastRequest).toBeNull();
  });

  it('screenshot posts the validated body and returns base64 PNG', async () => {
    fakePort = await startFakeServer({
      '/api/screenshot': (_req, body) => {
        const parsed = JSON.parse(body);
        if (parsed.view?.kind !== 'named' || parsed.view?.name !== 'iso-ftr') {
          return { status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'bad view' }) };
        }
        return { status: 200, contentType: 'image/png', body: ONE_PIXEL_PNG };
      },
    });
    writeRegistry([entry()]);

    const result = await screenshot({
      view: { kind: 'named', name: 'iso-ftr' },
      width: 400,
      height: 400,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.image.mimeType).toBe('image/png');
    expect(result.data.image.base64).toBe(ONE_PIXEL_PNG.toString('base64'));
    expect(lastRequest?.url).toBe('/api/screenshot');
    expect(lastRequest?.method).toBe('POST');
  });

  it('screenshot_multi adds multi:true to the body', async () => {
    fakePort = await startFakeServer({
      '/api/screenshot': (_req, body) => {
        const parsed = JSON.parse(body);
        if (parsed.multi !== true) {
          return { status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'missing multi' }) };
        }
        return { status: 200, contentType: 'image/png', body: ONE_PIXEL_PNG };
      },
    });
    writeRegistry([entry()]);

    const result = await screenshotMulti({ width: 800, height: 800 });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.image.base64).toBe(ONE_PIXEL_PNG.toString('base64'));
  });

  it('screenshot_shape fetches the bounding box and frames it with a look-from view', async () => {
    let postedView: any = null;
    fakePort = await startFakeServer({
      '/api/shape-properties': () => ({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          volume: 1000,
          boundingBox: { min: [0, 0, 0], max: [10, 10, 10] },
        }),
      }),
      '/api/screenshot': (_req, body) => {
        postedView = JSON.parse(body).view;
        return { status: 200, contentType: 'image/png', body: ONE_PIXEL_PNG };
      },
    });
    writeRegistry([entry()]);

    const result = await screenshotShape({ shapeId: 'sh-1', margin: 1.5 });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(postedView).not.toBeNull();
    expect(postedView.kind).toBe('look-from');
    expect(postedView.target).toEqual([5, 5, 5]);
    // Iso-ftr direction with positive distance: eye-x > center, eye-y < center, eye-z > center.
    expect(postedView.eye[0]).toBeGreaterThan(5);
    expect(postedView.eye[1]).toBeLessThan(5);
    expect(postedView.eye[2]).toBeGreaterThan(5);
  });

  it('screenshot_shape rejects an empty shapeId', async () => {
    const result = await screenshotShape({ shapeId: '' });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe('invalid-input');
  });

  it('get_camera_state forwards the cached payload', async () => {
    fakePort = await startFakeServer({
      '/api/camera/state': () => ({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          type: 'camera-state',
          position: [50, -50, 40],
          target: [0, 0, 0],
          up: [0, 0, 1],
          projection: 'orthographic',
        }),
      }),
    });
    writeRegistry([entry()]);

    const result = await getCameraState({});
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.position).toEqual([50, -50, 40]);
    expect(result.data.projection).toBe('orthographic');
  });

  it('http errors are surfaced with code=http-error and the status code', async () => {
    fakePort = await startFakeServer({
      '/api/screenshot': () => ({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'No UI client connected.' }),
      }),
    });
    writeRegistry([entry()]);

    const result = await screenshot({});
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe('http-error');
    expect((result.details as any)?.statusCode).toBe(503);
  });
});

describe('screenshot tools (over MCP)', () => {
  it('image results are rendered as MCP image content blocks', async () => {
    fakePort = await startFakeServer({
      '/api/screenshot': () => ({ status: 200, contentType: 'image/png', body: ONE_PIXEL_PNG }),
    });
    writeRegistry([entry()]);

    const server = buildServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({
        name: 'screenshot',
        arguments: { workspace: '/tmp/ws-mcp-shot', view: { kind: 'named', name: 'front' } },
      });
      expect(result.isError).not.toBe(true);
      const block = (result.content as any[])[0];
      expect(block.type).toBe('image');
      expect(block.mimeType).toBe('image/png');
      expect(block.data).toBe(ONE_PIXEL_PNG.toString('base64'));
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('the four screenshot tools are exposed in the tool list', async () => {
    const server = buildServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const tools = await client.listTools();
      const names = new Set(tools.tools.map((t) => t.name));
      for (const expected of ['screenshot', 'screenshot_multi', 'screenshot_shape', 'get_camera_state']) {
        expect(names.has(expected)).toBe(true);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });
});
