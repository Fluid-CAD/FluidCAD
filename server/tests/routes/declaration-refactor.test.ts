// A parameters-panel rename or delete reaching every file of the workspace
// that reads the declaration: the routes plan against the files on disk (or
// the host's buffers), send each consumer file's edit through the
// apply-feature round trip ahead of the declaring file's own, and refuse the
// whole delete — before any file changes — when the value cannot stand in
// for a read somewhere.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'http';
import { mkdtemp, writeFile, mkdir, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createParamsRouter } from '../../src/routes/params.ts';
import { createPropertyEditsRouter } from '../../src/routes/property-edits.ts';
import { createApplyFeatureRouter } from '../../src/routes/apply-feature/index.ts';
import { FeatureEditDispatcher } from '../../src/edit-dispatch.ts';

let server: http.Server;
let baseUrl: string;
let workspace: string;
let relayed: any[];
/** The host's buffers, keyed by absolute path — what each round trip edits and what it leaves behind. */
let buffers: Record<string, string>;
let currentFile: string;

const HOUSING = [
  `import { part, param, sketch, circle, extrude, property } from 'fluidcad/core';`,
  ``,
  `export const housing = part('Housing', () => {`,
  `  const width = param('Width', 60);`,
  `  const wall = param('Wall', 4);`,
  `  sketch('xy', () => {`,
  `    circle(width);`,
  `  });`,
  `  extrude(25);`,
  `  property('Pocket diameter', 'pocketDiameter', width - 2 * wall);`,
  `  property('Bolt count', 'boltCount', 4);`,
  `});`,
  ``,
].join('\n');

const PLUG = [
  `import { part, extrude } from 'fluidcad/core';`,
  `import { housing } from './housing.part.js';`,
  ``,
  `export const plug = part('Plug', () => {`,
  `  extrude(housing.properties.pocketDiameter - 0.4);`,
  `  extrude(housing.properties.boltCount * 2);`,
  `});`,
  ``,
].join('\n');

const FRAME = [
  `import { assembly, insert } from 'fluidcad/core';`,
  `import { housing } from './parts/housing.part.js';`,
  ``,
  `const wide = insert(housing, { Width: 100, Wall: 3 }).grounded();`,
  `insert(housing, { Width: 50 }).translate(120, 0, 0);`,
  `const gap = wide.properties.boltCount;`,
  ``,
].join('\n');

const fakeServer = {
  getCurrentCode: () => buffers[currentFile],
  getCurrentFileName: () => currentFile,
  getLiveBuffer: (filePath: string) => buffers[filePath] ?? null,
  renameParam: () => {},
  forgetParam: () => {},
};

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
 * through /code/apply-feature against the buffer of the file it names, and
 * the result becomes that file's buffer — so a later spec sees the earlier
 * one's edit, as the real hosts' buffers would.
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
    const filePath = msg.spec.filePath;
    order.push(filePath);
    // A file the host had no buffer of is loaded from disk on demand, as the real hosts do.
    buffers[filePath] ??= await readFile(filePath, 'utf8');
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

describe('declaration rename and delete across the workspace', () => {
  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'fluidcad-refactor-'));
    await mkdir(join(workspace, 'parts'));
    // The plug lives on disk only; the assembly and the housing come from the host's buffers.
    await writeFile(join(workspace, 'parts/plug.part.js'), PLUG);
    await writeFile(join(workspace, 'parts/housing.part.js'), '// stale on disk — the buffer wins\n');
    await writeFile(join(workspace, 'frame.assembly.js'), '// stale on disk — the buffer wins\n');
    await writeFile(join(workspace, 'notes.md'), 'housing.part is mentioned here but this is not a script');

    const app = express();
    app.use(express.json());
    const send = (msg: any) => {
      relayed.push(msg);
      return true;
    };
    const dispatcher = new FeatureEditDispatcher(fakeServer as any, send, { ackTimeoutMs: 500 });
    app.use('/api', createParamsRouter(fakeServer as any, send, () => {}, dispatcher, undefined, workspace));
    app.use('/api', createPropertyEditsRouter(fakeServer as any, dispatcher, workspace));
    app.use('/api', createApplyFeatureRouter(fakeServer as any, send, { dispatcher }));
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(workspace, { recursive: true, force: true });
  });

  beforeEach(() => {
    relayed = [];
    currentFile = join(workspace, 'parts/housing.part.js');
    buffers = {
      [join(workspace, 'parts/housing.part.js')]: HOUSING,
      [join(workspace, 'frame.assembly.js')]: FRAME,
    };
  });

  it('reports every file that reads a parameter, and what a delete does in each', async () => {
    const res = await fetch(`${baseUrl}/api/params/usage?label=Width&line=4`);
    expect(res.status).toBe(200);
    const usage = await res.json();
    expect(usage).toMatchObject({ variable: 'width', references: 2, value: '60', portable: true });
    expect(usage.usages).toEqual([
      { filePath: join(workspace, 'parts/housing.part.js'), count: 2, lines: [7, 10] },
      { filePath: join(workspace, 'frame.assembly.js'), count: 2, lines: [4, 5] },
    ]);
    expect(usage.deletion).toEqual({
      value: '60',
      replaced: [{ filePath: join(workspace, 'parts/housing.part.js'), count: 2, lines: [7, 10] }],
      dropped: [{ filePath: join(workspace, 'frame.assembly.js'), count: 2, lines: [4, 5] }],
      blocked: [],
    });
  });

  it('renames a parameter: the assembly overrides first, then the variable and its reads', async () => {
    const { body, order } = await actAsEditor(post('/params/update', {
      label: 'Width',
      line: 4,
      param: { label: 'Outer width', defaultValue: 60, type: 'number' },
    }));
    expect(body.success).toBe(true);
    expect(order).toEqual([join(workspace, 'frame.assembly.js'), join(workspace, 'parts/housing.part.js')]);
    const housing = buffers[join(workspace, 'parts/housing.part.js')];
    expect(housing).toContain(`const outerWidth = param('Outer width', 60);`);
    expect(housing).toContain(`circle(outerWidth);`);
    expect(housing).toContain(`property('Pocket diameter', 'pocketDiameter', outerWidth - 2 * wall);`);
    const frame = buffers[join(workspace, 'frame.assembly.js')];
    expect(frame).toContain(`insert(housing, { 'Outer width': 100, Wall: 3 }).grounded();`);
    expect(frame).toContain(`insert(housing, { 'Outer width': 50 }).translate(120, 0, 0);`);
  });

  it('deletes a parameter: the default replaces its reads and the overrides go', async () => {
    const { body } = await actAsEditor(post('/params/remove', { label: 'Wall', line: 5 }));
    expect(body.success).toBe(true);
    const housing = buffers[join(workspace, 'parts/housing.part.js')];
    expect(housing).not.toContain('Wall');
    expect(housing).toContain(`property('Pocket diameter', 'pocketDiameter', width - 2 * 4);`);
    expect(buffers[join(workspace, 'frame.assembly.js')]).toContain(`insert(housing, { Width: 100 }).grounded();`);
  });

  it('renames a property through the reads in a file on disk and one in a buffer', async () => {
    const { body, order } = await actAsEditor(post('/properties/update', {
      name: 'boltCount',
      line: 11,
      property: { label: 'Bolts', name: 'bolts', expression: '4' },
    }));
    expect(body.success).toBe(true);
    expect(order).toEqual([
      join(workspace, 'frame.assembly.js'),
      join(workspace, 'parts/plug.part.js'),
      join(workspace, 'parts/housing.part.js'),
    ]);
    expect(buffers[join(workspace, 'parts/housing.part.js')]).toContain(`property('Bolts', 'bolts', 4);`);
    expect(buffers[join(workspace, 'parts/plug.part.js')]).toContain(`extrude(housing.properties.bolts * 2);`);
    expect(buffers[join(workspace, 'frame.assembly.js')]).toContain(`const gap = wide.properties.bolts;`);
  });

  it('deletes a property whose value travels, inlining it wherever it is read', async () => {
    const { body } = await actAsEditor(post('/properties/remove', { name: 'boltCount', line: 11 }));
    expect(body.success).toBe(true);
    expect(buffers[join(workspace, 'parts/housing.part.js')]).not.toContain('boltCount');
    expect(buffers[join(workspace, 'parts/plug.part.js')]).toContain(`extrude(4 * 2);`);
    expect(buffers[join(workspace, 'frame.assembly.js')]).toContain(`const gap = 4;`);
  });

  it('refuses to delete a property whose value only means something in its own part, before any file changes', async () => {
    const usage = await (await fetch(`${baseUrl}/api/properties/usage?name=pocketDiameter&line=10`)).json();
    expect(usage.portable).toBe(false);
    expect(usage.deletion.blocked).toEqual([{ filePath: join(workspace, 'parts/plug.part.js'), count: 1, lines: [5] }]);

    const { status, body } = await post('/properties/remove', { name: 'pocketDiameter', line: 10 });
    expect(status).toBe(422);
    expect(body.reason).toContain('the value of "pocketDiameter" (width - 2 * wall) reads names that are out of scope at plug.part.js (line 5)');
    expect(relayed).toEqual([]);
  });

  it('stops at a consumer the host refuses and leaves the declaration alone', async () => {
    // The host answers the assembly's edit honestly and refuses the plug's
    // — its buffer has moved on — so the sequence stops there.
    const pending = post('/properties/update', { name: 'boltCount', line: 11, property: { label: 'Bolts', name: 'bolts', expression: '4' } });
    let handled = 0;
    let result: { status: number; body: any } | null = null;
    void pending.then((value) => { result = value; });
    while (result === null) {
      const msg = relayed.filter((m) => m.type === 'apply-feature-edit')[handled];
      if (!msg) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        continue;
      }
      handled++;
      const refused = msg.spec.filePath.endsWith('plug.part.js');
      buffers[msg.spec.filePath] ??= await readFile(msg.spec.filePath, 'utf8');
      await fetch(`${baseUrl}/api/code/apply-feature`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: refused ? 'not the buffer you planned against' : buffers[msg.spec.filePath],
          spec: refused ? { ...msg.spec, usageEdit: undefined, paramEdit: { kind: 'remove', expectedLabel: 'nope' } } : msg.spec,
        }),
      });
    }
    const outcome = result as { status: number; body: any };
    expect(outcome.status).toBe(422);
    expect(outcome.body.reason).toContain('plug.part.js:');
    expect(outcome.body.reason).toContain('1 other file already updated');
    expect(relayed.filter((m) => m.type === 'apply-feature-edit').map((m) => m.spec.filePath.split('/').pop()))
      .toEqual(['frame.assembly.js', 'plug.part.js']);
  });
});
