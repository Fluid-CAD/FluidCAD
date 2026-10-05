// The part row's Rename reaching every file of the workspace that imports
// the part: the route plans against the declaring file, sends each
// importing file's edit through the apply-feature round trip ahead of the
// declaring file's own, and only then renames the part and its variable.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'http';
import { mkdtemp, writeFile, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createTimelineRouter } from '../../src/routes/timeline.ts';
import { createApplyFeatureRouter } from '../../src/routes/apply-feature/index.ts';
import { FeatureEditDispatcher } from '../../src/edit-dispatch.ts';

let server: http.Server;
let baseUrl: string;
let workspace: string;
let relayed: any[];
/** The host's buffers, keyed by absolute path — what each round trip edits and what it leaves behind. */
let buffers: Record<string, string>;
let currentFile: string;

const CARCASE = [
  `import { part, param, property } from 'fluidcad/core';`,
  ``,
  `export const box = part('Carcase', () => {`,
  `  const width = param('Width', 500);`,
  `  property('Internal width', 'InternalWidth', width - 36);`,
  `});`,
  ``,
].join('\n');

const CABINET = [
  `import { insert, assembly } from 'fluidcad/core';`,
  `import { box } from './carcase.part.js';`,
  `import { drawer } from './drawer.part.js';`,
  ``,
  `export const main = assembly('main', () => {`,
  `  const carcase = insert(box, { Width: 400 }).grounded();`,
  `  const drawer1 = insert(drawer, { Width: carcase.properties.InternalWidth });`,
  `});`,
  ``,
].join('\n');

const SHOWROOM = [
  `import { insert } from 'fluidcad/core';`,
  `import { box as shell } from './carcase.part.js';`,
  ``,
  `insert(shell);`,
  ``,
].join('\n');

const fakeServer = {
  getCurrentCode: () => buffers[currentFile],
  getCurrentFileName: () => currentFile,
  getLiveBuffer: (filePath: string) => buffers[filePath] ?? null,
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
 * the result becomes that file's buffer.
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

describe('part rename across the workspace', () => {
  const file = (name: string) => join(workspace, name);

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'fluidcad-part-rename-'));
    // The importers live on disk only; the part comes from the host's buffer.
    await writeFile(file('cabinet.assembly.js'), CABINET);
    await writeFile(file('showroom.assembly.js'), SHOWROOM);
    await writeFile(file('carcase.part.js'), '// stale on disk — the buffer wins\n');

    const app = express();
    app.use(express.json());
    const send = (msg: any) => {
      relayed.push(msg);
      return true;
    };
    const dispatcher = new FeatureEditDispatcher(fakeServer as any, send, { ackTimeoutMs: 500 });
    app.use('/api', createTimelineRouter(fakeServer as any, send, () => {}, { dispatcher, workspacePath: workspace }));
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
    currentFile = file('carcase.part.js');
    buffers = { [file('carcase.part.js')]: CARCASE };
  });

  it('follows the part through the files that import it, before renaming it', async () => {
    const result = await actAsEditor(post('/rename-part', {
      sourceLocation: { filePath: currentFile, line: 3, column: 0 }, name: 'MyCarcase2',
    }));
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ success: true });
    expect(result.order.slice(0, -1).sort()).toEqual([file('cabinet.assembly.js'), file('showroom.assembly.js')]);
    expect(result.order.at(-1)).toBe(file('carcase.part.js'));

    expect(buffers[file('carcase.part.js')]).toContain(`export const myCarcase2 = part('MyCarcase2', () => {`);
    const cabinet = buffers[file('cabinet.assembly.js')];
    expect(cabinet).toContain(`import { myCarcase2 } from './carcase.part.js';`);
    expect(cabinet).toContain(`const carcase = insert(myCarcase2, { Width: 400 }).grounded();`);
    // An aliased import keeps the name its file reads the part by.
    const showroom = buffers[file('showroom.assembly.js')];
    expect(showroom).toContain(`import { myCarcase2 as shell } from './carcase.part.js';`);
    expect(showroom).toContain(`insert(shell);`);
  });

  it('touches only its own file when the variable already matches the name', async () => {
    buffers[file('carcase.part.js')] = CARCASE.replace(`part('Carcase'`, `part('Shell'`);
    const result = await actAsEditor(post('/rename-part', {
      sourceLocation: { filePath: currentFile, line: 3, column: 0 }, name: 'Box',
    }));
    expect(result.status).toBe(200);
    expect(result.order).toEqual([file('carcase.part.js')]);
    expect(buffers[file('carcase.part.js')]).toContain(`export const box = part('Box', () => {`);
  });

  it('refuses a line that holds no part(), leaving every file alone', async () => {
    const result = await actAsEditor(post('/rename-part', {
      sourceLocation: { filePath: currentFile, line: 4, column: 2 }, name: 'Shell',
    }));
    expect(result.status).toBe(422);
    expect(result.body.reason).toMatch(/no part\(\) statement starts on line 4/);
    expect(buffers[file('carcase.part.js')]).toBe(CARCASE);
    expect(buffers[file('cabinet.assembly.js')]).toBeUndefined();
  });

  it('rejects a body without a name', async () => {
    const result = await post('/rename-part', { sourceLocation: { filePath: currentFile, line: 3, column: 0 }, name: '' });
    expect(result.status).toBe(400);
  });
});
