import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { FluidCadServer, ScratchBuildRefusal, ScratchBuildStore } from '../../src/fluidcad-server/index.ts';
import type { ScratchBuildOutcome, ScratchBuildRequest } from '../../src/fluidcad-server/index.ts';
import { createScratchBuildRouter } from '../../src/routes/scratch-build.ts';

let server: http.Server;
let baseUrl: string;
let workspace: string;
let outside: string;
let engine: FluidCadServer;
let requests: ScratchBuildRequest[];
/** What the stubbed build answers next; a function throws or decides per request. */
let answer: ScratchBuildOutcome | null | ((request: ScratchBuildRequest) => ScratchBuildOutcome | null);

const RENDERED = (file: string): ScratchBuildOutcome => ({
  state: 'rendered',
  id: ScratchBuildStore.newId(),
  file,
  sceneKind: 'part',
  unit: 'mm',
  durationMs: 12,
  builtFrom: 'source',
  configuration: 'Default',
  sessionOverrides: 0,
  unusedParams: [],
  solidCount: 1,
  bounds: { min: [0, 0, 0], max: [10, 10, 10] },
  volume: 1000,
  validation: { ok: true, checked: 1, findings: [], skipped: 0 },
  geometry: 'digest',
});

async function post(body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}/api/scratch-build`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function meshes(id: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}/api/scratch-build/${id}/meshes`);
  return { status: res.status, body: await res.json() };
}

/**
 * The engine is stubbed at `scratchBuild`: the route's body validation,
 * workspace confinement and status mapping are under test, not the build
 * (tests/scratch-build.test.ts covers that).
 */
describe('the scratch build routes', () => {
  beforeAll(async () => {
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-scratch-route-'))).replace(/\\/g, '/');
    outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-scratch-outside-'))).replace(/\\/g, '/');
    fs.writeFileSync(path.join(workspace, 'block.part.js'), '// a model\n');
    fs.writeFileSync(path.join(outside, 'secret.part.js'), '// not this workspace\'s\n');
    fs.symlinkSync(path.join(outside, 'secret.part.js'), path.join(workspace, 'linked.part.js'));

    engine = new FluidCadServer();
    engine.scratchBuild = async (request) => {
      requests.push(request);
      return typeof answer === 'function' ? answer(request) : answer;
    };
    const app = express();
    // The limit index.ts mounts the API with: a long candidate reaches the route.
    app.use(express.json({ limit: '50mb' }));
    app.use('/api', createScratchBuildRouter(engine, workspace));
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  beforeEach(() => {
    requests = [];
    answer = request => RENDERED(request.file);
  });

  it('builds a workspace model and answers the outcome, by absolute or workspace-relative path', async () => {
    const file = `${workspace}/block.part.js`;
    const absolute = await post({ file, source: 'candidate', params: { Height: 10, Sizes: [1, 'M3'], On: true } });
    expect(absolute.status).toBe(200);
    expect(absolute.body).toMatchObject({ state: 'rendered', file, volume: 1000 });
    expect(requests).toEqual([{ file, source: 'candidate', params: { Height: 10, Sizes: [1, 'M3'], On: true } }]);

    const relative = await post({ file: 'block.part.js' });
    expect(relative.status).toBe(200);
    expect(requests[1]).toEqual({ file });
  });

  it('takes a file that does not exist yet when it lies in the workspace', async () => {
    const { status } = await post({ file: 'parts/new.fluid.js', source: 'candidate' });
    expect(status).toBe(200);
    expect(requests[0].file).toBe(`${workspace}/parts/new.fluid.js`);
  });

  it('answers a candidate that fails as a 200 with its state', async () => {
    answer = request => ({ state: 'compile-error', file: request.file, durationMs: 3, compileError: { message: 'Unexpected token', filePath: request.file } });
    const { status, body } = await post({ file: 'block.part.js', source: 'const = ;' });
    expect(status).toBe(200);
    expect(body).toMatchObject({ state: 'compile-error', compileError: { message: 'Unexpected token' } });
  });

  it('refuses a malformed body before any build', async () => {
    for (const body of [
      [],
      {},
      { file: '' },
      { file: 7 },
      { file: 'block.part.js', source: 5 },
      { file: 'block.part.js', source: 'x'.repeat(2_000_001) },
      { file: 'block.part.js', params: [] },
      { file: 'block.part.js', params: 'Height=10' },
      { file: 'block.part.js', params: { Height: { nested: 1 } } },
      { file: 'block.part.js', params: { Height: null } },
      { file: 'block.part.js', params: { Height: Number.NaN } },
      { file: 'block.part.js', params: { '': 1 } },
    ]) {
      const { status, body: answered } = await post(body);
      expect(status, JSON.stringify(body).slice(0, 80)).toBe(400);
      expect(typeof answered.error).toBe('string');
    }
    expect(requests).toEqual([]);
  });

  it('refuses a file outside the workspace, by path, by dots and through a link', async () => {
    for (const file of [`${outside}/secret.part.js`, '../escape.part.js', `${workspace}/../x.part.js`, 'linked.part.js', '/etc/passwd']) {
      const { status } = await post({ file, source: 'candidate' });
      expect(status, file).toBe(403);
    }
    expect(requests).toEqual([]);
  });

  it('refuses a file that is no model', async () => {
    for (const file of ['project.params.js', 'gear.feature.js', 'helper.js', 'fluidcad.json']) {
      const { status, body } = await post({ file, source: 'candidate' });
      expect(status, file).toBe(422);
      expect(body.error).toContain('not a model');
    }
    expect(requests).toEqual([]);
  });

  it('maps a refusal to its status, no engine to 503 and a thrown error to 500', async () => {
    answer = () => {
      throw new ScratchBuildRefusal(404, 'cannot be read');
    };
    expect(await post({ file: 'block.part.js' })).toEqual({ status: 404, body: { error: 'cannot be read' } });

    answer = null;
    expect((await post({ file: 'block.part.js' })).status).toBe(503);

    answer = () => {
      throw new Error('kernel said no');
    };
    expect(await post({ file: 'block.part.js' })).toEqual({ status: 500, body: { error: 'kernel said no' } });
  });

  it('passes `reuse` on, and refuses one that is no boolean', async () => {
    expect((await post({ file: 'block.part.js', source: 'candidate', reuse: true })).status).toBe(200);
    expect(requests[0]).toEqual({ file: `${workspace}/block.part.js`, source: 'candidate', reuse: true });
    expect((await post({ file: 'block.part.js', reuse: false })).status).toBe(200);
    expect(requests[1]).toEqual({ file: `${workspace}/block.part.js` });
    expect((await post({ file: 'block.part.js', reuse: 'yes' })).status).toBe(400);
    expect(requests).toHaveLength(2);
  });

  it('answers what a build would cost, behind the checks of a build', async () => {
    const asked: ScratchBuildRequest[] = [];
    const cost = async (body: unknown): Promise<{ status: number; body: any }> => {
      const res = await fetch(`${baseUrl}/api/scratch-build/cost`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: res.status, body: await res.json() };
    };
    engine.scratchBuildCost = async (request) => {
      asked.push(request);
      return { reusable: null, lastBuildMs: 840 };
    };
    expect(await cost({ file: 'block.part.js', source: 'candidate' })).toEqual({ status: 200, body: { reusable: null, lastBuildMs: 840 } });
    expect(asked).toEqual([{ file: `${workspace}/block.part.js`, source: 'candidate' }]);
    expect((await cost({ file: `${outside}/secret.part.js` })).status).toBe(403);
    expect((await cost({ file: 'notes.txt' })).status).toBe(422);
    expect((await cost({})).status).toBe(400);
    expect(asked).toHaveLength(1);
    // Nothing was built for any of them.
    expect(requests).toEqual([]);

    engine.scratchBuildCost = async () => null;
    expect((await cost({ file: 'block.part.js' })).status).toBe(503);
    engine.scratchBuildCost = async () => {
      throw new ScratchBuildRefusal(501, 'cannot build a candidate');
    };
    expect(await cost({ file: 'block.part.js' })).toEqual({ status: 501, body: { error: 'cannot build a candidate' } });
  });

  it('serves a build\'s meshes by id while the store keeps them, and 404 otherwise', async () => {
    const id = ScratchBuildStore.newId();
    const stored = { id, file: `${workspace}/block.part.js`, sceneKind: 'part' as const, unit: 'mm' as const, objects: [{ id: 'row', sceneShapes: [] }] };
    engine.scratchBuilds.put(stored);

    const found = await meshes(id);
    expect(found.status).toBe(200);
    expect(found.body).toEqual(stored);

    expect((await meshes(ScratchBuildStore.newId())).status).toBe(404);
    expect((await meshes('not-an-id')).status).toBe(404);
    expect((await meshes(encodeURIComponent('../../etc/passwd'))).status).toBe(404);
  });
});
