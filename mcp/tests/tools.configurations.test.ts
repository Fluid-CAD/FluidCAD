import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../src/server.ts';
import { registryFilePath } from '../src/discovery.ts';
import { exportShapes, recompute, selectConfiguration } from '../src/tools/engine.ts';
import { screenshot, screenshotMulti } from '../src/tools/screenshot.ts';
import { getSceneSummary } from '../src/tools/inspection.ts';
import type { RegistryEntry } from '../src/types.ts';

// The MCP side of configurations (docs/assembly-configurations-plan.md §3.7):
// select_configuration, `configuration` on recompute / export / screenshot /
// screenshot_multi, and the table on get_scene_summary.

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
const TABLE = {
  active: 'Default',
  names: ['Compact', 'Wide'],
  rows: { Compact: { width: 500 }, Wide: { width: 1200 } },
  modified: false,
};

let fakeHome: string;
let homeSpy: ReturnType<typeof vi.spyOn>;
let fakeServer: http.Server | null = null;
let workspace: string;
let requests: { method: string; url: string; body: any }[];
let table: typeof TABLE;

function startFakeServer(): Promise<number> {
  return new Promise((resolve) => {
    fakeServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const body = text ? JSON.parse(text) : undefined;
        const url = (req.url ?? '').split('?')[0];
        requests.push({ method: req.method ?? '', url, body });
        const json = (status: number, payload: unknown) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(payload));
        };
        switch (url) {
          case '/api/health':
            return json(200, { ok: true, version: '0.0.47', workspacePath: workspace, startedAt: 'x', pid: process.pid });
          case '/api/configurations':
            return json(200, table);
          case '/api/configurations/select':
            table = { ...table, active: body.name };
            return json(200, { success: true, configurations: table });
          case '/api/recompute':
            return json(200, { success: true, state: 'rendered', objectErrors: [] });
          case '/api/scene/summary':
            return json(200, { schemaVersion: 1, file: `${workspace}/rack.assembly.js`, objects: [], configurations: table });
          case '/api/export':
            res.writeHead(200, { 'content-type': 'application/step' });
            return res.end('ISO-10303-21;');
          case '/api/pack':
            res.writeHead(200, { 'content-type': 'application/zip', 'x-fluidcad-package-name': 'rack' });
            return res.end('PK');
          case '/api/screenshot':
            res.writeHead(200, { 'content-type': 'image/png' });
            return res.end(PNG);
          default:
            return json(404, { error: 'not found' });
        }
      });
    });
    fakeServer.listen(0, '127.0.0.1', () => {
      const addr = fakeServer!.address();
      resolve(typeof addr === 'object' && addr ? addr.port : 0);
    });
  });
}

beforeEach(async () => {
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-mcp-config-home-'));
  homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
  workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-mcp-config-ws-')));
  requests = [];
  table = { ...TABLE };
  const port = await startFakeServer();
  const entry: RegistryEntry = {
    workspacePath: workspace,
    port,
    pid: process.pid,
    version: '0.0.47',
    startedAt: '2026-10-21T12:00:00.000Z',
  };
  fs.mkdirSync(path.dirname(registryFilePath()), { recursive: true });
  fs.writeFileSync(registryFilePath(), JSON.stringify({ schemaVersion: 1, instances: [entry] }));
});

afterEach(async () => {
  homeSpy.mockRestore();
  fs.rmSync(fakeHome, { recursive: true, force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
  if (fakeServer) {
    await new Promise<void>((resolve) => fakeServer!.close(() => resolve()));
    fakeServer = null;
  }
});

const posted = (url: string) => requests.filter((r) => r.method === 'POST' && r.url === url);

describe('select_configuration', () => {
  it('selects a declared row and answers the table', async () => {
    const result = await selectConfiguration({ name: 'Wide' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(posted('/api/configurations/select').map((r) => r.body)).toEqual([{ name: 'Wide' }]);
    expect(result.data.configurations?.active).toBe('Wide');
  });

  it('refuses a row the model does not declare, listing the names, without switching', async () => {
    const result = await selectConfiguration({ name: 'Huge' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('unknown-configuration');
    expect(result.message).toMatch(/'Compact', 'Wide'/);
    expect(result.details).toEqual({ names: ['Compact', 'Wide'] });
    expect(posted('/api/configurations/select')).toEqual([]);
  });

  it('always accepts Default, even without a table', async () => {
    table = { active: 'Default', names: [], rows: {}, modified: false };
    const result = await selectConfiguration({ name: 'Default' });
    expect(result.ok).toBe(true);
    expect(posted('/api/configurations/select')).toHaveLength(1);
  });

  it('refuses a missing name', async () => {
    const result = await selectConfiguration({ name: '' });
    expect(result.ok === false && result.code).toBe('invalid-input');
    expect(requests).toEqual([]);
  });
});

describe('configuration on the other tools', () => {
  it('recompute selects the row first, then recomputes', async () => {
    const result = await recompute({ configuration: 'Compact' });
    expect(result.ok).toBe(true);
    const order = requests.filter((r) => r.method === 'POST').map((r) => r.url);
    expect(order).toEqual(['/api/configurations/select', '/api/recompute']);
    expect(posted('/api/configurations/select')[0].body).toEqual({ name: 'Compact' });
  });

  it('recompute with an unknown row neither switches nor recomputes', async () => {
    const result = await recompute({ configuration: 'Huge' });
    expect(result.ok === false && result.code).toBe('unknown-configuration');
    expect(posted('/api/recompute')).toEqual([]);
  });

  it('recompute without a configuration does not touch the table', async () => {
    await recompute({});
    expect(requests.some((r) => r.url.startsWith('/api/configurations'))).toBe(false);
  });

  it('export, screenshot and screenshot_multi forward the row', async () => {
    expect((await exportShapes({ format: 'step', shapeIds: ['s1'], configuration: 'Wide' })).ok).toBe(true);
    expect(posted('/api/export')[0].body.configuration).toBe('Wide');

    expect((await screenshot({ configuration: 'Wide' })).ok).toBe(true);
    expect((await screenshotMulti({ configuration: 'Compact' })).ok).toBe(true);
    const shots = posted('/api/screenshot').map((r) => r.body);
    expect(shots[0].configuration).toBe('Wide');
    expect(shots[1]).toMatchObject({ configuration: 'Compact', multi: true });

  });

  it('leaves configuration out of the bodies when not given', async () => {
    await exportShapes({ format: 'step', shapeIds: ['s1'] });
    await screenshot({});
    for (const url of ['/api/export', '/api/screenshot']) {
      expect(posted(url)[0].body).not.toHaveProperty('configuration');
    }
  });

  it('refuses an empty configuration before contacting the server', async () => {
    expect((await exportShapes({ format: 'step', shapeIds: ['s1'], configuration: ' ' })).ok).toBe(false);
    expect((await screenshot({ configuration: '' })).ok).toBe(false);
    expect(requests.filter((r) => r.method === 'POST')).toEqual([]);
  });

  it('get_scene_summary passes the table through', async () => {
    const result = await getSceneSummary({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.data as any).configurations).toEqual(TABLE);
  });
});

describe('over MCP', () => {
  it('lists select_configuration and the configuration argument on every tool that takes one', async () => {
    const server = buildServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const { tools } = await client.listTools();
      const byName = new Map(tools.map((t) => [t.name, t]));
      expect((byName.get('select_configuration')?.inputSchema as any)?.required).toContain('name');
      for (const name of ['recompute', 'export', 'screenshot', 'screenshot_multi']) {
        expect(Object.keys((byName.get(name)?.inputSchema as any)?.properties ?? {})).toContain('configuration');
      }

      const result = await client.callTool({ name: 'select_configuration', arguments: { workspace, name: 'Huge' } });
      expect(result.isError).toBe(true);
      const payload = JSON.parse((result.content as any[])[0].text);
      expect(payload).toMatchObject({ code: 'unknown-configuration', details: { names: ['Compact', 'Wide'] } });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
