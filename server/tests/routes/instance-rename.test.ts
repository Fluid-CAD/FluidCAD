// The parts panel's Rename reaching every file of the workspace that reads
// the instance: the route plans against the declaring file, sends each
// reading file's edit through the apply-feature round trip ahead of the
// declaring file's own, and only then renames the binding itself.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'http';
import { mkdtemp, writeFile, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createInstancePoseRouter } from '../../src/routes/instance-pose.ts';
import { createApplyFeatureRouter } from '../../src/routes/apply-feature/index.ts';
import { FeatureEditDispatcher } from '../../src/edit-dispatch.ts';

let server: http.Server;
let baseUrl: string;
let workspace: string;
let relayed: any[];
/** The host's buffers, keyed by absolute path — what each round trip edits and what it leaves behind. */
let buffers: Record<string, string>;
let currentFile: string;

const RIG = [
  `import { assembly, insert, mate } from 'fluidcad/core';`,
  `import { bracket } from './bracket.part.js';`,
  `import { plate } from './plate.part.js';`,
  ``,
  `export const rig = assembly('rig', () => {`,
  `  const bracket1 = insert(bracket).name('bracket1');`,
  `  const plate1 = insert(plate).name('plate1');`,
  `  mate('fastened', bracket1.connectors.base, plate1.connectors.top);`,
  `  return { bracket1 };`,
  `});`,
  ``,
].join('\n');

const MACHINE = [
  `import { insert, mate } from 'fluidcad/core';`,
  `import { rig } from './rig.assembly.js';`,
  `import { tower } from './tower.assembly.js';`,
  ``,
  `const rig1 = insert(rig).grounded();`,
  `const tower1 = insert(tower);`,
  `mate('revolute', rig1.parts.bracket1.connectors.pivot, tower1.parts.bracket1.connectors.pivot);`,
  ``,
].join('\n');

const LAYOUT = [
  `import { insert } from 'fluidcad/core';`,
  `import { bracket } from './bracket.part.js';`,
  ``,
  `export const anchor = insert(bracket).grounded();`,
  ``,
].join('\n');

const FIXTURE = [
  `import { insert, mate } from 'fluidcad/core';`,
  `import { anchor } from './layout.assembly.js';`,
  `import { plate } from './plate.part.js';`,
  ``,
  `const plate1 = insert(plate);`,
  `mate('fastened', plate1.connectors.top, anchor.connectors.base);`,
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

describe('instance rename across the workspace', () => {
  const file = (name: string) => join(workspace, name);

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'fluidcad-instance-rename-'));
    // The readers live on disk only; the files being renamed in come from the host's buffers.
    await writeFile(file('machine.assembly.js'), MACHINE);
    await writeFile(file('fixture.assembly.js'), FIXTURE);
    await writeFile(file('rig.assembly.js'), '// stale on disk — the buffer wins\n');
    await writeFile(file('layout.assembly.js'), '// stale on disk — the buffer wins\n');

    const app = express();
    app.use(express.json());
    const send = (msg: any) => {
      relayed.push(msg);
      return true;
    };
    const dispatcher = new FeatureEditDispatcher(fakeServer as any, send, { ackTimeoutMs: 500 });
    app.use('/api', createInstancePoseRouter(fakeServer as any, dispatcher, workspace));
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
    currentFile = file('rig.assembly.js');
    buffers = {
      [file('rig.assembly.js')]: RIG,
      [file('layout.assembly.js')]: LAYOUT,
    };
  });

  it('follows a returned part through the files that insert its assembly, before renaming it', async () => {
    const result = await actAsEditor(post('/rename-instance', {
      filePath: currentFile, sourceLine: 6, name: 'Left bracket', defaultName: 'Bracket',
    }));
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ success: true });
    expect(result.order).toEqual([file('machine.assembly.js'), file('rig.assembly.js')]);

    // Only the occurrence of this assembly is followed: the tower returns a part of the same name.
    expect(buffers[file('machine.assembly.js')]).toContain(
      `mate('revolute', rig1.parts.leftBracket.connectors.pivot, tower1.parts.bracket1.connectors.pivot);`,
    );
    const rig = buffers[file('rig.assembly.js')];
    expect(rig).toContain(`const leftBracket = insert(bracket).name("Left bracket");`);
    expect(rig).toContain(`mate('fastened', leftBracket.connectors.base, plate1.connectors.top);`);
    expect(rig).toContain(`return { leftBracket };`);
  });

  it('touches only its own file for an instance nothing outside reads', async () => {
    const result = await actAsEditor(post('/rename-instance', {
      filePath: currentFile, sourceLine: 7, name: 'Base plate',
    }));
    expect(result.status).toBe(200);
    expect(result.order).toEqual([file('rig.assembly.js')]);
    expect(buffers[file('rig.assembly.js')]).toContain(`const basePlate = insert(plate).name("Base plate");`);
    expect(buffers[file('rig.assembly.js')]).toContain(`mate('fastened', bracket1.connectors.base, basePlate.connectors.top);`);
  });

  it('follows an exported binding through the files that import it', async () => {
    currentFile = file('layout.assembly.js');
    const result = await actAsEditor(post('/rename-instance', {
      filePath: currentFile, sourceLine: 4, name: 'Datum',
    }));
    expect(result.status).toBe(200);
    expect(result.order).toEqual([file('fixture.assembly.js'), file('layout.assembly.js')]);
    expect(buffers[file('layout.assembly.js')]).toContain(`export const datum = insert(bracket).grounded().name("Datum");`);
    const fixture = buffers[file('fixture.assembly.js')];
    expect(fixture).toContain(`import { datum } from './layout.assembly.js';`);
    expect(fixture).toContain(`mate('fastened', plate1.connectors.top, datum.connectors.base);`);
  });

  it('refuses a line that holds no insert(), leaving every file alone', async () => {
    const result = await actAsEditor(post('/rename-instance', {
      filePath: currentFile, sourceLine: 8, name: 'Left bracket',
    }));
    expect(result.status).toBe(422);
    expect(result.body.reason).toMatch(/no insert\(\) statement starts on line 8/);
    expect(buffers[file('rig.assembly.js')]).toBe(RIG);
    expect(buffers[file('machine.assembly.js')]).toBeUndefined();
  });

  it('refuses an instance whose insert() lives in another file', async () => {
    const result = await post('/rename-instance', {
      filePath: file('machine.assembly.js'), sourceLine: 5, name: 'Main rig',
    });
    expect(result.status).toBe(422);
    expect(result.body.reason).toMatch(/machine\.assembly\.js — open that file to rename it/);
  });

  it('rejects a body without a name', async () => {
    const result = await post('/rename-instance', { filePath: currentFile, sourceLine: 6, name: '  ' });
    expect(result.status).toBe(400);
  });
});
