// The global-parameters routes (`docs/global-parameters-plan.md` §2.5):
// `GET /api/global-params` answers the catalog, `POST /api/global-params/set`
// rewrites a declaration's default literal — through the editor host's
// apply-feature-edit round trip when one is attached, straight to disk plus a
// `keepCurrent` render when none is — and `/api/render` refuses a params
// file as a model.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'http';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createGlobalParamsRouter } from '../src/routes/global-params.ts';
import { createApplyFeatureRouter } from '../src/routes/apply-feature/index.ts';
import { createRenderRouter, type RenderOutcome } from '../src/routes/render.ts';
import { FeatureEditDispatcher } from '../src/edit-dispatch.ts';
import { GlobalParamCatalog } from '../src/global-params/catalog.ts';
import { normalizePath } from '../src/normalize-path.ts';

const PROJECT = [
  `import { param } from 'fluidcad/core';`,
  ``,
  `export const wall = param('Wall thickness', 3, 'slider', { min: 1, max: 10, step: 0.5 }); // shell`,
  `export const bolt = param('Bolt', 'M4', 'select', { options: [{ label: 'M3', value: 'M3' }, { label: 'M4', value: 'M4' }] });`,
  `export const width = param('Width', 120);`,
  `export const innerWidth = width - 2 * wall;`,
  ``,
].join('\n');

let ws: string;
let file: string;
let server: http.Server;
let baseUrl: string;
let relayed: any[];
let hasHost: boolean;
let writes: { absPath: string; code: string }[];
let renders: { fileName: string; code: string; keepCurrent?: boolean }[];
let changed: string[];
let catalog: GlobalParamCatalog;
/** The in-page host's buffer of the params file, when it holds one. */
let buffer: string | null;

const fakeServer = {
  getCurrentFileName: () => '/ws/bracket.part.js',
  getCurrentCode: () => `import { part } from 'fluidcad/core';\nexport const b = part('B', () => {});\n`,
  getLiveBuffer: (absPath: string) => (normalizePath(absPath) === file ? buffer : null),
};

async function get(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}/api${path}`);
  return { status: res.status, body: await res.json() };
}

async function post(path: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

/** Answer the next dispatch the way a live editor would: round-trip the spec over its buffer. */
async function actAsEditor(): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const msg = relayed.find((m) => m.type === 'apply-feature-edit');
    if (msg) {
      const res = await fetch(`${baseUrl}/api/code/apply-feature`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: readFileSync(msg.spec.filePath, 'utf8'), spec: msg.spec }),
      });
      const { newCode } = await res.json();
      buffer = newCode;
      return newCode;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('nothing was relayed to the editor host');
}

describe('global parameter routes', () => {
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    const send = (msg: any) => {
      relayed.push(msg);
      return hasHost;
    };
    const dispatcher = new FeatureEditDispatcher(fakeServer as any, send, { ackTimeoutMs: 500 });
    app.use('/api', createGlobalParamsRouter({
      get catalog() { return catalog; },
      dispatcher,
      get workspacePath() { return ws; },
      hasEditorHost: () => hasHost,
      readFile: async (absPath) => fakeServer.getLiveBuffer(absPath) ?? readFileSync(absPath, 'utf8'),
      writeFile: async (absPath, code) => {
        writes.push({ absPath, code });
        writeFileSync(absPath, code);
      },
      runLiveRender: async (fileName, code, options) => {
        renders.push({ fileName, code, keepCurrent: options.keepCurrent });
        return { state: 'rendered', version: 1, absPath: '/ws/bracket.part.js', durationMs: 0 };
      },
      onChanged: (absPath) => {
        changed.push(absPath);
        catalog.noteFileChange(absPath);
      },
    } as any));
    app.use('/api', createApplyFeatureRouter(fakeServer as any, send, { dispatcher }));
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    ws = realpathSync(mkdtempSync(join(tmpdir(), 'fluidcad-globals-routes-')));
    file = normalizePath(join(ws, 'project.params.js'));
    writeFileSync(file, PROJECT);
    buffer = null;
    catalog = new GlobalParamCatalog({
      workspacePath: ws,
      readBuffer: (p) => fakeServer.getLiveBuffer(p),
      projectUnit: () => 'mm',
    });
    relayed = [];
    writes = [];
    renders = [];
    changed = [];
    hasHost = false;
  });

  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  it('GET answers the catalog snapshot', async () => {
    const { status, body } = await get('/global-params');
    expect(status).toBe(200);
    expect(body.projectUnit).toBe('mm');
    expect(body.files).toHaveLength(1);
    expect(body.files[0]).toMatchObject({ file, relPath: 'project.params.js', problems: [] });
    expect(body.files[0].params.map((p: any) => [p.name, p.value])).toEqual([
      ['wall', 3], ['bolt', 'M4'], ['width', 120], ['innerWidth', 114],
    ]);
  });

  it('with no editor host, rewrites only the default literal on disk and re-renders the open model as a dependency', async () => {
    const { status, body } = await post('/global-params/set', { file, label: 'Wall thickness', value: '4.5' });
    expect(status).toBe(200);
    expect(body).toMatchObject({ success: true, value: 4.5, render: { state: 'rendered' } });

    expect(writes).toHaveLength(1);
    expect(writes[0].absPath).toBe(file);
    const expected = PROJECT.replace(
      `param('Wall thickness', 3, 'slider', { min: 1, max: 10, step: 0.5 }); // shell`,
      `param('Wall thickness', 4.5, 'slider', { min: 1, max: 10, step: 0.5 }); // shell`,
    );
    expect(readFileSync(file, 'utf8')).toBe(expected);
    expect(renders).toEqual([{ fileName: file, code: expected, keepCurrent: true }]);
    expect(changed).toEqual([file]);
    expect(relayed).toHaveLength(0);

    // The catalog follows: the derived export reads the new wall.
    const { body: after } = await get('/global-params');
    expect(after.files[0].params.map((p: any) => [p.name, p.value])).toEqual([
      ['wall', 4.5], ['bolt', 'M4'], ['width', 120], ['innerWidth', 111],
    ]);
  });

  it('with an editor host, dispatches the update through the apply-feature-edit round trip', async () => {
    hasHost = true;
    const pending = post('/global-params/set', { file, label: 'Bolt', value: 'M3' });
    const newCode = await actAsEditor();
    const { status, body } = await pending;

    expect(status).toBe(200);
    expect(body).toMatchObject({ success: true, value: 'M3' });
    expect(newCode).toBe(PROJECT.replace(`param('Bolt', 'M4', 'select'`, `param('Bolt', 'M3', 'select'`));
    expect(relayed[0].spec).toMatchObject({
      filePath: file,
      paramEdit: { kind: 'update', expectedLabel: 'Bolt', line: 4, param: { label: 'Bolt', defaultValue: 'M3', type: 'select' } },
    });
    expect(writes).toHaveLength(0);
    expect(renders).toHaveLength(0);
    expect(changed).toEqual([file]);
    // The host's buffer is what the catalog reads next.
    expect((await get('/global-params')).body.files[0].params[1].value).toBe('M3');
  });

  it('coerces the value toward the declared default', async () => {
    await post('/global-params/set', { file, label: 'Width', value: '150' });
    expect(readFileSync(file, 'utf8')).toContain(`param('Width', 150);`);
  });

  it('refuses a value no option matches, a derived export, an unknown label and a non-params file', async () => {
    expect(await post('/global-params/set', { file, label: 'Bolt', value: 'M5' })).toMatchObject({
      status: 422, body: { success: false, reason: 'the default value is not one of the options' },
    });
    expect(await post('/global-params/set', { file, label: 'innerWidth', value: 1 })).toMatchObject({
      status: 422, body: { success: false, reason: expect.stringContaining('is derived') },
    });
    expect((await post('/global-params/set', { file, label: 'Nope', value: 1 })).status).toBe(404);
    expect((await post('/global-params/set', { file: join(ws, 'other.params.js'), label: 'Width', value: 1 })).status).toBe(404);
    expect((await post('/global-params/set', { file: join(ws, 'bracket.part.js'), label: 'Width', value: 1 })).status).toBe(422);
    expect((await post('/global-params/set', { file, label: 'Width' })).status).toBe(400);
    expect((await post('/global-params/set', { label: 'Width', value: 1 })).status).toBe(400);
    expect(writes).toHaveLength(0);
    expect(readFileSync(file, 'utf8')).toBe(PROJECT);
  });
});

describe('POST /api/render — params files', () => {
  let renderServer: http.Server;
  let renderUrl: string;
  let calls: { fileName: string; keepCurrent: boolean }[] = [];

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', createRenderRouter(async (fileName, _code, options): Promise<RenderOutcome> => {
      calls.push({ fileName, keepCurrent: options.keepCurrent });
      return { state: 'rendered', version: 1, absPath: '/ws/bracket.part.js', durationMs: 0 };
    }));
    renderServer = http.createServer(app);
    await new Promise<void>((resolve) => renderServer.listen(0, '127.0.0.1', () => resolve()));
    const addr = renderServer.address();
    renderUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => renderServer.close(() => resolve()));
  });

  beforeEach(() => {
    calls = [];
  });

  async function render(body: unknown): Promise<{ status: number; body: any }> {
    const res = await fetch(`${renderUrl}/api/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  }

  it('refuses to render a params file as a model', async () => {
    const { status, body } = await render({ filePath: '/ws/project.params.js', code: '// p' });
    expect(status).toBe(422);
    expect(body.error).toContain('parameters file, not a model');
    expect(calls).toHaveLength(0);
  });

  it('folds a params file into the open model when asked to keep the current one', async () => {
    const { status } = await render({ filePath: '/ws/project.params.js', code: '// p', keepCurrent: true });
    expect(status).toBe(200);
    expect(calls).toEqual([{ fileName: '/ws/project.params.js', keepCurrent: true }]);
  });
});
