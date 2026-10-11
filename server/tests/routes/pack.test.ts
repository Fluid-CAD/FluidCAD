import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import JSZip from 'jszip';
import { createPackRouter } from '../../src/routes/pack.ts';
import { InProcessEngine } from '../../src/packages/in-process-engine.ts';
import type { FluidCadServer } from '../../src/fluidcad-server/index.ts';

// `POST /api/pack` packs the open workspace's package through the
// workspace's running engine. Here the engine is a real one, booted in
// process over a copy of fixtures/package-workspace, as `fluidcad serve`
// would run it.

const FIXTURE = path.resolve(__dirname, '../fixtures/package-workspace');

let scratch: string;
let ws: string;
let engine: InProcessEngine;
let server: http.Server;
let baseUrl: string;
/** The editor buffers the engine reports, by absolute path. */
let buffers: Map<string, string>;

async function post(body?: unknown): Promise<{ status: number; headers: Headers; bytes: Buffer }> {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const res = await fetch(`${baseUrl}/api/pack`, body === undefined
      ? { method: 'POST' }
      : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, headers: res.headers, bytes: Buffer.from(await res.arrayBuffer()) };
  } finally {
    log.mockRestore();
  }
}

function writeConfig(edit: (config: Record<string, any>) => void): void {
  const file = path.join(ws, 'fluidcad.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  edit(config);
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
}

beforeAll(async () => {
  scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fluidcad-pack-route-'));
  ws = path.join(scratch, 'kit');
  fs.cpSync(FIXTURE, ws, { recursive: true });
  engine = await InProcessEngine.boot(ws, { linkEngine: false });
  buffers = new Map();
  // The running engine, with the editor buffers this test decides.
  const live = engine.server as FluidCadServer;
  vi.spyOn(live, 'getLiveBuffer').mockImplementation((file: string) => buffers.get(file) ?? null);

  const app = express();
  app.use(express.json());
  app.use('/api', createPackRouter(live, ws, '0.0.46'));
  server = http.createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await engine.close();
  fs.rmSync(scratch, { recursive: true, force: true });
});

beforeEach(() => {
  buffers.clear();
  fs.rmSync(ws, { recursive: true, force: true });
  fs.cpSync(FIXTURE, ws, { recursive: true });
});

describe('POST /api/pack', () => {
  it('returns the package archive, named for its bare name and version', async () => {
    const res = await post();

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('x-fluidcad-package-name')).toBe('kit');
    expect(res.headers.get('x-fluidcad-package-version')).toBe('0.1.0');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="kit-0.1.0.fluidpkg"');

    const zip = await JSZip.loadAsync(res.bytes);
    const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir).sort();
    expect(names).toContain('manifest.json');
    expect(names).toContain('index.js');
    expect(names).toContain('parts/spacer.part.js');
    expect(names).not.toContain('demo.part.js');
    expect(names).not.toContain('init.js');
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
    expect(manifest.features.map((f: { id: string }) => f.id)).toEqual(['fastener', 'standoff']);
    // Nothing was written to the workspace.
    expect(fs.readdirSync(ws).filter((n) => n.endsWith('.fluidpkg'))).toEqual([]);
  });

  it('answers 400 with the CLI\'s sentence in a workspace that isn\'t a package', async () => {
    writeConfig((config) => {
      delete config.package;
    });
    const res = await post();
    expect(res.status).toBe(400);
    expect(JSON.parse(res.bytes.toString('utf8'))).toEqual({
      error: "This workspace isn't a package — run `fluidcad package init` first.",
      code: 'refused',
    });
  });

  it('answers 400 with the layout code when a pack check fails', async () => {
    fs.writeFileSync(path.join(ws, 'parts', 'pair.assembly.js'), 'export const NOTHING = 1;\n');
    const res = await post();
    expect(res.status).toBe(400);
    expect(JSON.parse(res.bytes.toString('utf8'))).toEqual({
      error: 'parts/pair.assembly.js is an assembly in parts/, but assemblies belong in assemblies/: move it there.',
      code: 'wrong-folder',
    });
  });

  it('answers the archive and its contents by folder as JSON with { format: "json" }', async () => {
    const res = await post({ format: 'json' });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.bytes.toString('utf8'));
    expect(body).toMatchObject({
      packageName: 'kit',
      version: '0.1.0',
      fileName: 'kit-0.1.0.fluidpkg',
    });
    expect(body.contents.features.map((f: { module: string }) => f.module)).toEqual([
      'features/fastener.feature.js',
      'features/standoff.feature.js',
    ]);
    expect(body.contents.parts.map((p: { module: string }) => p.module)).toEqual(['parts/spacer.part.js']);
    expect(body.contents.assemblies).toEqual([]);
    expect(body.contents.models).toBe(1);
    const archive = Buffer.from(body.archive, 'base64');
    expect(body.bytes).toBe(archive.length);
    const zip = await JSZip.loadAsync(archive);
    expect(zip.file('features/standoff.feature.js')).not.toBeNull();
  });

  it('refuses a file whose editor buffer isn\'t saved', async () => {
    buffers.set(path.join(ws, 'features', 'standoff.feature.js').replace(/\\/g, '/'), '// unsaved\n');
    const res = await post();
    expect(res.status).toBe(400);
    expect(JSON.parse(res.bytes.toString('utf8')).error).toBe(
      'features/standoff.feature.js has unsaved changes: save it, then pack again.',
    );
  });
});
