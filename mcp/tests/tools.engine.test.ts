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
  addBreakpoint,
  clearBreakpoints,
  exportShapes,
  importStep,
  recompute,
  rollbackTo,
} from '../src/tools/engine.ts';
import type { RegistryEntry } from '../src/types.ts';

let fakeHome: string;
let homeSpy: ReturnType<typeof vi.spyOn>;
let fakeServer: http.Server | null = null;
let fakePort = 0;
let workspace: string;
let requests: { method: string; url: string; body: string }[] = [];

type ExportConfig = {
  /** If set, the export route writes this many bytes to saveAsPath and
   *  returns JSON. If null, falls through to the default STEP body. */
  saveBytes?: Buffer | null;
  /** Override the binary body returned when saveAsPath is absent. */
  body?: Buffer;
  /** Content-type for the binary response. */
  contentType?: string;
  /** HTTP status to return. */
  status?: number;
  /** Last parsed body — populated after each call. */
  lastBody?: any;
};
let exportConfig: ExportConfig = {};

function entry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    workspacePath: workspace,
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
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        requests.push({ method: req.method ?? '', url: req.url ?? '', body });
        const url = (req.url ?? '').split('?')[0];

        if (url === '/api/health') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, version: '0.0.33', workspacePath: workspace, startedAt: 'x', pid: process.pid }));
          return;
        }

        if (url === '/api/recompute' || url === '/api/rollback'
            || url === '/api/add-breakpoint' || url === '/api/clear-breakpoints') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
          return;
        }

        if (url === '/api/import-file') {
          const parsed = JSON.parse(body);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ success: true, fileName: parsed.fileName?.replace(/\.(step|stp)$/i, '') }));
          return;
        }

        if (url === '/api/export') {
          const parsed = JSON.parse(body);
          exportConfig.lastBody = parsed;
          const status = exportConfig.status ?? 200;
          if (parsed.saveAsPath && exportConfig.saveBytes !== null) {
            const bytes = exportConfig.saveBytes ?? Buffer.from('ISO-10303-21;\nEND-ISO-10303-21;\n');
            // Mimic the real server: write to disk + return JSON.
            const target = path.resolve(workspace, parsed.saveAsPath);
            fs.writeFileSync(target, bytes);
            res.writeHead(status, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ savedTo: target, bytesWritten: bytes.length }));
            return;
          }
          const bin = exportConfig.body ?? Buffer.from('ISO-10303-21;\nEND-ISO-10303-21;\n');
          const ct = exportConfig.contentType ?? (parsed.format === 'step' ? 'application/step' : 'application/sla');
          res.writeHead(status, { 'content-type': ct });
          res.end(bin);
          return;
        }

        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
      });
    });
    fakeServer.listen(0, '127.0.0.1', () => {
      const addr = fakeServer!.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve(port);
    });
  });
}

beforeEach(async () => {
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-mcp-engine-test-'));
  homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-engine-ws-'));
  workspace = fs.realpathSync(workspace);
  requests = [];
  exportConfig = {};
  fakePort = await startFakeServer();
  writeRegistry([entry()]);
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

describe('recompute', () => {
  it('POSTs /api/recompute', async () => {
    const result = await recompute({});
    expect(result.ok).toBe(true);
    expect(requests.find((r) => r.url === '/api/recompute')?.method).toBe('POST');
  });
});

describe('rollback_to', () => {
  it('POSTs the index to /api/rollback', async () => {
    const result = await rollbackTo({ index: 2 });
    expect(result.ok).toBe(true);
    const sent = requests.find((r) => r.url === '/api/rollback');
    expect(sent?.method).toBe('POST');
    expect(JSON.parse(sent!.body)).toEqual({ index: 2 });
  });

  it('rejects a negative index', async () => {
    const result = await rollbackTo({ index: -1 });
    expect(result.ok).toBe(false);
    if (result.ok) { return; }
    expect(result.code).toBe('invalid-input');
  });

  it('rejects a non-integer index', async () => {
    const result = await rollbackTo({ index: 1.5 });
    expect(result.ok).toBe(false);
    if (result.ok) { return; }
    expect(result.code).toBe('invalid-input');
  });
});

describe('add_breakpoint', () => {
  it('normalizes file+line into sourceLocation', async () => {
    const result = await addBreakpoint({ file: '/abs/part.fluid.js', line: 12 });
    expect(result.ok).toBe(true);
    const sent = requests.find((r) => r.url === '/api/add-breakpoint');
    expect(JSON.parse(sent!.body)).toEqual({
      sourceLocation: { filePath: '/abs/part.fluid.js', line: 12 },
    });
  });

  it('rejects empty file', async () => {
    const result = await addBreakpoint({ file: '', line: 0 });
    expect(result.ok).toBe(false);
    if (result.ok) { return; }
    expect(result.code).toBe('invalid-input');
  });
});

describe('clear_breakpoints', () => {
  it('POSTs /api/clear-breakpoints', async () => {
    const result = await clearBreakpoints({});
    expect(result.ok).toBe(true);
    expect(requests.find((r) => r.url === '/api/clear-breakpoints')?.method).toBe('POST');
  });
});

describe('import_step', () => {
  it('reads the file, base64-encodes, and POSTs to /api/import-file', async () => {
    const stepFile = path.join(workspace, 'cube.step');
    const stepBytes = Buffer.from('ISO-10303-21;\nDATA;\nEND-ISO-10303-21;\n');
    fs.writeFileSync(stepFile, stepBytes);

    const result = await importStep({ path: stepFile });
    expect(result.ok).toBe(true);
    const sent = requests.find((r) => r.url === '/api/import-file');
    expect(sent?.method).toBe('POST');
    const parsed = JSON.parse(sent!.body);
    expect(parsed.fileName).toBe('cube.step');
    expect(Buffer.from(parsed.data, 'base64').equals(stepBytes)).toBe(true);
  });

  it('returns invalid-input for a missing file', async () => {
    const result = await importStep({ path: path.join(workspace, 'missing.step') });
    expect(result.ok).toBe(false);
    if (result.ok) { return; }
    expect(result.code).toBe('invalid-input');
  });
});

describe('export', () => {
  it('saveAsPath round-trip: server writes bytes; tool returns savedTo', async () => {
    const out = path.join(workspace, 'out.step');
    const result = await exportShapes({
      format: 'step',
      shapeIds: ['sh-1'],
      saveAsPath: out,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) { return; }
    const data = result.data as { savedTo: string; bytesWritten: number };
    expect(data.savedTo).toBe(out);
    expect(data.bytesWritten).toBeGreaterThan(0);
    const written = fs.readFileSync(out);
    expect(written.toString('utf8').startsWith('ISO-10303-21;')).toBe(true);
    expect(exportConfig.lastBody.resolution).toBe('medium');
  });

  it('without saveAsPath returns base64 + content-type', async () => {
    exportConfig.body = Buffer.from('solid mock\nendsolid mock\n');
    exportConfig.contentType = 'application/sla';
    const result = await exportShapes({ format: 'stl', shapeIds: ['sh-2'] });
    expect(result.ok).toBe(true);
    if (!result.ok) { return; }
    const data = result.data as { format: string; mimeType: string; base64: string; bytes: number };
    expect(data.format).toBe('stl');
    expect(data.mimeType).toBe('application/sla');
    expect(Buffer.from(data.base64, 'base64').toString('utf8')).toContain('solid mock');
    expect(data.bytes).toBeGreaterThan(0);
  });

  it('forwards resolution and includeColors', async () => {
    const result = await exportShapes({
      format: 'stl',
      shapeIds: ['sh-2'],
      resolution: 'fine',
      includeColors: true,
    });
    expect(result.ok).toBe(true);
    expect(exportConfig.lastBody.resolution).toBe('fine');
    expect(exportConfig.lastBody.includeColors).toBe(true);
  });

  it('rejects an empty shapeIds array', async () => {
    const result = await exportShapes({ format: 'step', shapeIds: [] });
    expect(result.ok).toBe(false);
    if (result.ok) { return; }
    expect(result.code).toBe('invalid-input');
  });

  it('rejects an invalid format', async () => {
    const result = await exportShapes({ format: 'obj' as any, shapeIds: ['sh-1'] });
    expect(result.ok).toBe(false);
    if (result.ok) { return; }
    expect(result.code).toBe('invalid-input');
  });

  it('surfaces server 4xx as http-error', async () => {
    exportConfig.status = 400;
    exportConfig.body = Buffer.from(JSON.stringify({ error: 'bad' }));
    exportConfig.contentType = 'application/json';
    const result = await exportShapes({ format: 'step', shapeIds: ['sh-1'] });
    expect(result.ok).toBe(false);
    if (result.ok) { return; }
    expect(result.code).toBe('http-error');
  });
});

describe('engine tools over MCP', () => {
  it('the MCP client sees all six engine tools', async () => {
    const server = buildServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const tools = await client.listTools();
      const names = new Set(tools.tools.map((t) => t.name));
      for (const expected of [
        'recompute',
        'rollback_to',
        'add_breakpoint',
        'clear_breakpoints',
        'import_step',
        'export',
      ]) {
        expect(names.has(expected)).toBe(true);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('rollback_to flows through MCP and returns a parseable payload', async () => {
    const server = buildServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({
        name: 'rollback_to',
        arguments: { workspace, index: 0 },
      });
      expect(result.isError).not.toBe(true);
      const payload = JSON.parse((result.content as any[])[0].text);
      expect(payload.success).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
