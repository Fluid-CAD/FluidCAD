// The parameters panel's declaration edits on a `*.params.js` file — a
// global parameter — through the shared `/params/add|update|remove|usage`
// routes (`docs/global-parameters-plan.md` §2.4, §3.2). A global is read by
// every file that imports it, so a rename follows the identifier into each
// consumer's import specifier and reads, and a delete inlines the literal
// there and drops the specifier. Without an editor host the routes write the
// disk themselves, consumers first and the declaring file last, folding each
// file into the open model with `keepCurrent`; with one attached every file's
// edit rides the apply-feature-edit round trip in that same order.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'http';
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createParamsRouter } from '../src/routes/params.ts';
import { createGlobalParamsRouter, type GlobalParamsRouterDeps } from '../src/routes/global-params.ts';
import { createApplyFeatureRouter } from '../src/routes/apply-feature/index.ts';
import { FeatureEditDispatcher } from '../src/edit-dispatch.ts';
import { GlobalParamCatalog } from '../src/global-params/catalog.ts';
import { normalizePath } from '../src/normalize-path.ts';

const PROJECT = [
  `import { param } from 'fluidcad/core';`,
  ``,
  `export const wall = param('Wall thickness', 3, 'slider', { min: 1, max: 10, step: 0.5 });`,
  `export const width = param('Width', 120);`,
  `export const innerWidth = width - 2 * wall;`,
  ``,
].join('\n');

/** The open model: reads two globals by their own names. */
const BRACKET = [
  `import { part, sketch, rect, extrude } from 'fluidcad/core';`,
  `import { wall, width } from './project.params.js';`,
  ``,
  `export const bracket = part('Bracket', () => {`,
  `  sketch('xy', () => {`,
  `    rect(width, wall);`,
  `  });`,
  `  extrude(wall * 2);`,
  `});`,
  ``,
].join('\n');

/** A consumer in a subfolder that imports the global under an alias. */
const LID = [
  `import { part, extrude } from 'fluidcad/core';`,
  `import { wall as shellWall } from '../project.params.js';`,
  ``,
  `export const lid = part('Lid', () => {`,
  `  extrude(shellWall);`,
  `});`,
  ``,
].join('\n');

/** Another params file whose derived export reads the global. */
const TOLERANCES = [
  `import { wall } from './project.params.js';`,
  ``,
  `export const clearance = wall / 10;`,
  ``,
].join('\n');

let ws: string;
let project: string;
let bracket: string;
let lid: string;
let tolerances: string;
let server: http.Server;
let baseUrl: string;
let relayed: any[];
let hasHost: boolean;
let writes: { absPath: string; code: string }[];
let renders: { fileName: string; code: string; keepCurrent?: boolean }[];
let changed: string[];
let catalog: GlobalParamCatalog;
/** The editor host's buffers, when it holds any — what each round trip edits. */
let buffers: Record<string, string>;

const fakeServer = {
  getCurrentFileName: () => bracket,
  getCurrentCode: () => buffers[bracket] ?? readFileSync(bracket, 'utf8'),
  getLiveBuffer: (absPath: string) => buffers[normalizePath(absPath)] ?? null,
  renameParam: () => {},
  forgetParam: () => {},
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

/**
 * Play the editor host until `pending` settles: every relayed spec is run
 * through /code/apply-feature against the buffer of the file it names (loaded
 * from disk on demand, as the real hosts do), and the result becomes that
 * file's buffer — so a later spec sees the earlier one's edit.
 */
async function actAsEditor(
  pending: Promise<{ status: number; body: any }>,
): Promise<{ status: number; body: any; order: string[] }> {
  const order: string[] = [];
  let done = false;
  const settled = pending.then((value) => {
    done = true;
    return value;
  });
  let handled = 0;
  while (!done) {
    const msg = relayed.filter((m) => m.type === 'apply-feature-edit')[handled];
    if (!msg) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      continue;
    }
    handled++;
    const filePath = normalizePath(msg.spec.filePath);
    order.push(filePath);
    buffers[filePath] ??= readFileSync(filePath, 'utf8');
    const res = await fetch(`${baseUrl}/api/code/apply-feature`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: buffers[filePath], spec: msg.spec }),
    });
    const result = await res.json();
    if (typeof result.newCode === 'string' && !result.error) {
      buffers[filePath] = result.newCode;
    }
  }
  return { ...(await settled), order };
}

describe('global parameter declaration edits', () => {
  beforeAll(async () => {
    // One workspace for the run: the routers take its path once, at
    // construction; each test rewrites its files.
    ws = realpathSync(mkdtempSync(join(tmpdir(), 'fluidcad-globals-edits-')));
    project = normalizePath(join(ws, 'project.params.js'));
    bracket = normalizePath(join(ws, 'bracket.part.js'));
    lid = normalizePath(join(ws, 'parts/lid.part.js'));
    tolerances = normalizePath(join(ws, 'tolerances.params.js'));
    const app = express();
    app.use(express.json());
    const send = (msg: any) => {
      relayed.push(msg);
      return hasHost;
    };
    const dispatcher = new FeatureEditDispatcher(fakeServer as any, send, { ackTimeoutMs: 500 });
    const deps: GlobalParamsRouterDeps = {
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
        return { state: 'rendered', version: 1, absPath: bracket, durationMs: 0 };
      },
      onChanged: (absPath) => {
        changed.push(absPath);
        catalog.noteFileChange(absPath);
      },
    } as any;
    app.use('/api', createParamsRouter(fakeServer as any, send, () => {}, dispatcher, undefined, ws, deps));
    app.use('/api', createGlobalParamsRouter(deps));
    app.use('/api', createApplyFeatureRouter(fakeServer as any, send, { dispatcher }));
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(ws, { recursive: true, force: true });
  });

  beforeEach(() => {
    for (const entry of readdirSync(ws)) {
      rmSync(join(ws, entry), { recursive: true, force: true });
    }
    writeFileSync(project, PROJECT);
    writeFileSync(bracket, BRACKET);
    mkdirSync(join(ws, 'parts'));
    writeFileSync(lid, LID);
    writeFileSync(tolerances, TOLERANCES);
    buffers = {};
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

  const disk = (absPath: string) => readFileSync(absPath, 'utf8');

  // -------------------------------------------------------------------------
  // add
  // -------------------------------------------------------------------------

  describe('POST /params/add with a `file`', () => {
    it('creates a missing params file from the template and appends the export after the import', async () => {
      const { status, body } = await post('/params/add', {
        file: 'fits.params.js',
        param: { label: 'Bolt clearance', defaultValue: 0.4, type: 'number', name: 'boltClearance' },
      });
      const fits = normalizePath(join(ws, 'fits.params.js'));
      expect(status).toBe(200);
      expect(body).toMatchObject({ success: true, name: 'boltClearance', file: fits, render: { state: 'rendered' } });
      expect(disk(fits)).toBe([
        `import { param } from 'fluidcad/core';`,
        ``,
        `export const boltClearance = param('Bolt clearance', 0.4);`,
        ``,
      ].join('\n'));
      expect(renders).toEqual([{ fileName: fits, code: disk(fits), keepCurrent: true }]);
      expect(changed).toEqual([fits]);
      expect(relayed).toHaveLength(0);
      // The catalog lists the new file.
      const { body: snapshot } = await get('/global-params');
      expect(snapshot.files.map((f: any) => f.relPath)).toEqual(['fits.params.js', 'project.params.js', 'tolerances.params.js']);
    });

    it('appends to an existing file after its last export, deriving the identifier from the label when none is given', async () => {
      const { status, body } = await post('/params/add', {
        file: project,
        param: { label: 'Corner radius', defaultValue: 2, type: 'slider', min: 0, max: 5, step: 0.5 },
      });
      expect(status).toBe(200);
      expect(body).toMatchObject({ success: true, name: 'cornerRadius', file: project });
      expect(disk(project)).toBe(PROJECT.replace(
        `export const innerWidth = width - 2 * wall;\n`,
        `export const innerWidth = width - 2 * wall;\nexport const cornerRadius = param('Corner radius', 2, 'slider', { min: 0, max: 5, step: 0.5 });\n`,
      ));
      expect(writes.map((w) => w.absPath)).toEqual([project]);
      expect(changed).toEqual([project]);
    });

    it("appends below the last statement's line, a trailing comment staying with its statement", async () => {
      writeFileSync(project, `import { param } from 'fluidcad/core';\n\nexport const width = param('Width', 120); // outer\n`);
      await post('/params/add', { file: project, param: { label: 'Wall', defaultValue: 3, type: 'number' } });
      expect(disk(project)).toBe(
        `import { param } from 'fluidcad/core';\n\nexport const width = param('Width', 120); // outer\nexport const wall = param('Wall', 3);\n`,
      );
    });

    it('appends after an import-only file with a blank line between', async () => {
      writeFileSync(project, `import { param } from 'fluidcad/core';\n`);
      await post('/params/add', { file: project, param: { label: 'Wall', defaultValue: 3, type: 'number' } });
      expect(disk(project)).toBe(`import { param } from 'fluidcad/core';\n\nexport const wall = param('Wall', 3);\n`);
    });

    it('pulls the param import into a file that lacks it', async () => {
      writeFileSync(project, `export const width = 120;\n`);
      await post('/params/add', { file: project, param: { label: 'Wall', defaultValue: 3, type: 'number' } });
      expect(disk(project)).toBe(`import { param } from 'fluidcad/core';\nexport const width = 120;\nexport const wall = param('Wall', 3);\n`);
    });

    it('refuses a name the file already binds, one that is no identifier, a reserved word, and a label the file already carries', async () => {
      const add = (param: Record<string, unknown>) => post('/params/add', { file: project, param: { defaultValue: 1, type: 'number', ...param } });
      expect(await add({ label: 'Thickness', name: 'wall' })).toMatchObject({
        status: 422, body: { success: false, reason: 'this file already declares "wall"' },
      });
      expect(await add({ label: 'Thickness', name: 'innerWidth' })).toMatchObject({
        status: 422, body: { success: false, reason: 'this file already declares "innerWidth"' },
      });
      expect(await add({ label: 'Thickness', name: 'wall thickness' })).toMatchObject({
        status: 422, body: { success: false, reason: expect.stringContaining('"wall thickness" cannot name a parameter') },
      });
      expect(await add({ label: 'Thickness', name: '2nd' })).toMatchObject({ status: 422 });
      expect(await add({ label: 'Thickness', name: 'class' })).toMatchObject({
        status: 422, body: { success: false, reason: expect.stringContaining('"class" cannot name a parameter') },
      });
      expect(await add({ label: 'Width', name: 'w' })).toMatchObject({
        status: 422, body: { success: false, reason: 'this file already has a parameter labelled "Width"' },
      });
      expect(disk(project)).toBe(PROJECT);
      expect(writes).toHaveLength(0);
      expect(renders).toHaveLength(0);
    });

    it('refuses a file that is not a params file, one outside the workspace, and a mixed scope', async () => {
      const param = { label: 'Thickness', defaultValue: 1, type: 'number' };
      expect((await post('/params/add', { file: 'bracket.part.js', param })).status).toBe(422);
      expect((await post('/params/add', { file: '/elsewhere/other.params.js', param })).status).toBe(403);
      expect((await post('/params/add', { file: project, assembly: true, param })).status).toBe(400);
      expect(writes).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // update
  // -------------------------------------------------------------------------

  describe('POST /params/update on a params file', () => {
    it('rewrites only the default when nothing else changes', async () => {
      const { status, body } = await post('/params/update', {
        filePath: project, line: 3, label: 'Wall thickness',
        param: { label: 'Wall thickness', defaultValue: 4, type: 'slider', min: 1, max: 10, step: 0.5, name: 'wall' },
      });
      expect(status).toBe(200);
      expect(body).toMatchObject({ success: true, name: 'wall', render: { state: 'rendered' } });
      expect(disk(project)).toBe(PROJECT.replace(`param('Wall thickness', 3, 'slider'`, `param('Wall thickness', 4, 'slider'`));
      expect(disk(bracket)).toBe(BRACKET);
      expect(disk(lid)).toBe(LID);
      expect(writes.map((w) => w.absPath)).toEqual([project]);
      expect(renders).toEqual([{ fileName: project, code: disk(project), keepCurrent: true }]);
      expect(changed).toEqual([project]);
    });

    it('renames the identifier through every consumer: specifiers and reads, an alias keeping its local name', async () => {
      const { status, body } = await post('/params/update', {
        filePath: project, line: 3, label: 'Wall thickness',
        param: { label: 'Wall thickness', defaultValue: 3, type: 'slider', min: 1, max: 10, step: 0.5, name: 'shell' },
      });
      expect(status).toBe(200);
      expect(body).toMatchObject({ success: true, name: 'shell' });
      // Consumers first, the declaring file last.
      expect(writes.map((w) => w.absPath)).toEqual([bracket, lid, tolerances, project]);
      expect(renders.map((r) => [r.fileName, r.keepCurrent])).toEqual([[bracket, true], [lid, true], [tolerances, true], [project, true]]);
      expect(disk(project)).toBe(PROJECT
        .replace(`export const wall = param(`, `export const shell = param(`)
        .replace(`width - 2 * wall`, `width - 2 * shell`));
      expect(disk(bracket)).toBe(BRACKET
        .replace(`import { wall, width }`, `import { shell, width }`)
        .replace(`rect(width, wall);`, `rect(width, shell);`)
        .replace(`extrude(wall * 2);`, `extrude(shell * 2);`));
      expect(disk(lid)).toBe(LID.replace(`import { wall as shellWall }`, `import { shell as shellWall }`));
      expect(disk(tolerances)).toBe(TOLERANCES
        .replace(`import { wall }`, `import { shell }`)
        .replace(`wall / 10`, `shell / 10`));
      expect(changed).toEqual([project]);
      // The catalog follows the rename.
      const { body: snapshot } = await get('/global-params');
      expect(snapshot.files.find((f: any) => f.file === project).params.map((p: any) => p.name)).toEqual(['shell', 'width', 'innerWidth']);
    });

    it('aliases the new name in a consumer that already binds it', async () => {
      writeFileSync(bracket, BRACKET.replace(`  extrude(wall * 2);`, `  const shell = 1;\n  extrude(wall * 2 + shell);`));
      const { status } = await post('/params/update', {
        filePath: project, line: 3, label: 'Wall thickness',
        param: { label: 'Wall thickness', defaultValue: 3, type: 'slider', min: 1, max: 10, step: 0.5, name: 'shell' },
      });
      expect(status).toBe(200);
      expect(disk(bracket)).toContain(`import { shell as wall, width } from './project.params.js';`);
      expect(disk(bracket)).toContain(`extrude(wall * 2 + shell);`);
    });

    it('renames the label alone: the literal changes, the identifier and every consumer stay', async () => {
      const { status, body } = await post('/params/update', {
        filePath: project, line: 3, label: 'Wall thickness',
        param: { label: 'Shell', defaultValue: 3, type: 'slider', min: 1, max: 10, step: 0.5, name: 'wall' },
      });
      expect(status).toBe(200);
      expect(body).toMatchObject({ success: true, name: 'wall' });
      expect(disk(project)).toBe(PROJECT.replace(`param('Wall thickness', 3`, `param('Shell', 3`));
      expect(disk(bracket)).toBe(BRACKET);
      expect(disk(lid)).toBe(LID);
      expect(disk(tolerances)).toBe(TOLERANCES);
      expect(writes.map((w) => w.absPath)).toEqual([project]);
    });

    it('refuses an identifier the file already declares, a non-identifier, and an unknown label — before any file changes', async () => {
      const update = (name: string, label = 'Wall thickness') => post('/params/update', {
        filePath: project, line: 3, label,
        param: { label: 'Wall thickness', defaultValue: 3, type: 'slider', name },
      });
      expect(await update('width')).toMatchObject({ status: 422, body: { success: false, reason: 'this file already declares "width"' } });
      expect(await update('my wall')).toMatchObject({ status: 422, body: { success: false, reason: '"my wall" cannot name a variable' } });
      expect(await update('wall', 'Nope')).toMatchObject({ status: 422, body: { success: false, reason: expect.stringContaining('no param() call labelled "Nope"') } });
      expect(disk(project)).toBe(PROJECT);
      expect(disk(bracket)).toBe(BRACKET);
      expect(writes).toHaveLength(0);
    });

    it('with an editor host, dispatches each consumer then the declaring file through the round trip', async () => {
      hasHost = true;
      const { status, body, order } = await actAsEditor(post('/params/update', {
        filePath: project, line: 3, label: 'Wall thickness',
        param: { label: 'Wall thickness', defaultValue: 3, type: 'slider', min: 1, max: 10, step: 0.5, name: 'shell' },
      }));
      expect(status).toBe(200);
      expect(body).toMatchObject({ success: true, name: 'shell' });
      expect(order).toEqual([bracket, lid, tolerances, project]);
      expect(buffers[bracket]).toContain(`import { shell, width } from './project.params.js';`);
      expect(buffers[bracket]).toContain(`rect(width, shell);`);
      expect(buffers[lid]).toContain(`import { shell as shellWall } from '../project.params.js';`);
      expect(buffers[tolerances]).toContain(`export const clearance = shell / 10;`);
      expect(buffers[project]).toContain(`export const shell = param('Wall thickness', 3, 'slider'`);
      expect(buffers[project]).toContain(`export const innerWidth = width - 2 * shell;`);
      expect(relayed.filter((m) => m.type === 'apply-feature-edit').map((m) => Object.keys(m.spec).find((k) => k === 'paramEdit' || k === 'usageEdit')))
        .toEqual(['usageEdit', 'usageEdit', 'usageEdit', 'paramEdit']);
      // The host's buffers are the source of truth: nothing was written or rendered here.
      expect(writes).toHaveLength(0);
      expect(renders).toHaveLength(0);
      expect(changed).toEqual([project]);
      expect(disk(project)).toBe(PROJECT);
    });
  });

  // -------------------------------------------------------------------------
  // remove
  // -------------------------------------------------------------------------

  describe('POST /params/remove on a params file', () => {
    it('inlines the literal into every consumer, drops their specifiers and the declaration', async () => {
      const { status, body } = await post('/params/remove', { filePath: project, line: 3, label: 'Wall thickness' });
      expect(status).toBe(200);
      expect(body).toMatchObject({ success: true, render: { state: 'rendered' } });
      expect(writes.map((w) => w.absPath)).toEqual([bracket, lid, tolerances, project]);
      // A multi-specifier import keeps the others; a lone specifier takes its line with it.
      expect(disk(bracket)).toBe(BRACKET
        .replace(`import { wall, width }`, `import { width }`)
        .replace(`rect(width, wall);`, `rect(width, 3);`)
        .replace(`extrude(wall * 2);`, `extrude(3 * 2);`));
      expect(disk(lid)).toBe(LID
        .replace(`import { wall as shellWall } from '../project.params.js';\n`, ``)
        .replace(`extrude(shellWall);`, `extrude(3);`));
      expect(disk(tolerances)).toBe(`export const clearance = 3 / 10;\n`);
      expect(disk(project)).toBe([
        `import { param } from 'fluidcad/core';`,
        ``,
        `export const width = param('Width', 120);`,
        `export const innerWidth = width - 2 * 3;`,
        ``,
      ].join('\n'));
      expect(changed).toEqual([project]);
      const { body: snapshot } = await get('/global-params');
      expect(snapshot.files.find((f: any) => f.file === project).params.map((p: any) => p.name)).toEqual(['width', 'innerWidth']);
    });

    it('refuses — before any file changes — when the default would not mean the same where it is read', async () => {
      writeFileSync(project, PROJECT.replace(
        `export const innerWidth = width - 2 * wall;`,
        `export const innerWidth = width - 2 * wall;\nexport const gap = param('Gap', wall);`,
      ));
      writeFileSync(bracket, BRACKET.replace(`import { wall, width }`, `import { wall, width, gap }`).replace(`extrude(wall * 2);`, `extrude(gap);`));
      const { status, body } = await post('/params/remove', { filePath: project, label: 'Gap' });
      expect(status).toBe(422);
      expect(body.success).toBe(false);
      expect(body.reason).toContain('the value of "Gap" (wall) reads names that are out of scope at bracket.part.js (line 8)');
      expect(writes).toHaveLength(0);
      expect(renders).toHaveLength(0);
    });

    it('with an editor host, dispatches the consumers then the declaring file', async () => {
      hasHost = true;
      const { status, order } = await actAsEditor(post('/params/remove', { filePath: project, line: 3, label: 'Wall thickness' }));
      expect(status).toBe(200);
      expect(order).toEqual([bracket, lid, tolerances, project]);
      expect(buffers[bracket]).toContain(`import { width } from './project.params.js';`);
      expect(buffers[bracket]).toContain(`rect(width, 3);`);
      expect(buffers[lid]).not.toContain('project.params');
      expect(buffers[project]).not.toContain('Wall thickness');
      expect(writes).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // usage
  // -------------------------------------------------------------------------

  describe('GET /params/usage on a params file', () => {
    it('counts the reads in every file that imports the global, the declaring file first', async () => {
      const { status, body } = await get(`/params/usage?label=${encodeURIComponent('Wall thickness')}&line=3&filePath=${encodeURIComponent(project)}`);
      expect(status).toBe(200);
      expect(body).toMatchObject({ label: 'Wall thickness', variable: 'wall', editable: true, value: '3', portable: true, references: 1, referenceLines: [5] });
      expect(body.usages).toEqual([
        { filePath: project, count: 1, lines: [5] },
        { filePath: bracket, count: 2, lines: [6, 8] },
        { filePath: lid, count: 1, lines: [5] },
        { filePath: tolerances, count: 1, lines: [3] },
      ]);
      expect(body.deletion).toEqual({
        value: '3',
        replaced: [
          { filePath: project, count: 1, lines: [5] },
          { filePath: bracket, count: 2, lines: [6, 8] },
          { filePath: lid, count: 1, lines: [5] },
          { filePath: tolerances, count: 1, lines: [3] },
        ],
        dropped: [],
        configurations: [],
        blocked: [],
      });
    });

    it('resolves a workspace-relative params file', async () => {
      const { status, body } = await get(`/params/usage?label=Width&filePath=project.params.js`);
      expect(status).toBe(200);
      expect(body.usages).toEqual([
        { filePath: project, count: 1, lines: [5] },
        { filePath: bracket, count: 1, lines: [6] },
      ]);
    });
  });
});
