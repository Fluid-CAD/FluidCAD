// The timeline's "Remove" on a hole: the dry-run reports the connectors the
// hole leaves without a reader, and the cascade deletes them with it through
// the editor round trip. A connector an assembly mates on — read by name,
// from another file of the workspace — is not one of them.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'http';
import { mkdtemp, writeFile, mkdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createTimelineRouter } from '../../src/routes/timeline.ts';
import { createApplyFeatureRouter } from '../../src/routes/apply-feature/index.ts';
import { FeatureEditDispatcher } from '../../src/edit-dispatch.ts';

let server: http.Server;
let baseUrl: string;
let workspace: string;
let relayed: any[];
/** The host's buffers, keyed by absolute path. */
let buffers: Record<string, string>;
let plateFile: string;

const PLATE = [
  `import { part, sketch, circle, extrude, hole, connector, fillet } from 'fluidcad/core';`,
  ``,
  `export const plate = part('Plate', () => {`,
  `  sketch('xy', () => { circle([0, 0], 80); });`,
  `  const e = extrude(10);`,
  `  const seat = connector('seat', e.endFaces(0).center());`,
  `  const h1 = connector('h1', e.endFaces(0).center()).offset(20, 0, 0);`,
  `  const drilled = hole('M6', seat, h1).clearance('close');`,
  `  fillet(0.5, drilled.startEdges());`,
  `});`,
  ``,
].join('\n');

/** Mates on the plate's `seat`; lives on disk only. */
const FRAME = [
  `import { insert, mate } from 'fluidcad/core';`,
  `import { plate } from './parts/plate.part.js';`,
  `import { post } from './parts/post.part.js';`,
  ``,
  `const base = insert(plate).grounded();`,
  `const p = insert(post);`,
  `mate('fastened', base.connectors.seat, p.connectors.h1);`,
  ``,
].join('\n');

const fakeServer = {
  getCurrentCode: () => buffers[plateFile],
  getCurrentFileName: () => plateFile,
  getLiveBuffer: (filePath: string) => buffers[filePath] ?? null,
};

async function post(body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}/api/remove-feature`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

/** Play the editor host until `pending` settles: each relayed spec edits the buffer of the file it names. */
async function actAsEditor(pending: Promise<{ status: number; body: any }>): Promise<{ status: number; body: any }> {
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
  return settled;
}

function lineOf(snippet: string): number {
  return PLATE.split('\n').findIndex((row) => row.includes(snippet)) + 1;
}

describe('POST /api/remove-feature — a hole\'s connectors', () => {
  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'fluidcad-remove-'));
    await mkdir(join(workspace, 'parts'));
    await writeFile(join(workspace, 'parts/plate.part.js'), '// stale on disk — the buffer wins\n');
    await writeFile(join(workspace, 'frame.assembly.js'), FRAME);
    plateFile = join(workspace, 'parts/plate.part.js');

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
    buffers = { [plateFile]: PLATE };
  });

  it('the dry-run lists the connector nothing reads, apart from the dependants, and edits nothing', async () => {
    const { status, body } = await post({ sourceLocation: { filePath: plateFile, line: lineOf('const drilled') }, dryRun: true });
    expect(status).toBe(200);
    expect(body).toEqual({
      success: true,
      dependents: [{ name: 'fillet', line: lineOf('fillet(0.5') }],
      connectors: [{ name: 'h1', line: lineOf('const h1') }],
    });
    expect(relayed).toEqual([]);
    expect(buffers[plateFile]).toBe(PLATE);
  });

  it('the cascade deletes the hole, its dependants and that connector — the one the assembly mates on stays', async () => {
    const { status, body } = await actAsEditor(
      post({ sourceLocation: { filePath: plateFile, line: lineOf('const drilled') }, cascade: true }),
    );
    expect(status).toBe(200);
    expect(body).toEqual({ success: true });
    expect(buffers[plateFile]).toBe([
      `import { part, sketch, circle, extrude, hole, connector, fillet } from 'fluidcad/core';`,
      ``,
      `export const plate = part('Plate', () => {`,
      `  sketch('xy', () => { circle([0, 0], 80); });`,
      `  const e = extrude(10);`,
      `  const seat = connector('seat', e.endFaces(0).center());`,
      `});`,
      ``,
    ].join('\n'));
  });

  it('a host buffer of the assembly that no longer reads the connector frees it', async () => {
    buffers[join(workspace, 'frame.assembly.js')] = FRAME.replace('base.connectors.seat', 'base.connectors.other');
    const { body } = await post({ sourceLocation: { filePath: plateFile, line: lineOf('const drilled') }, dryRun: true });
    expect(body.connectors).toEqual([
      { name: 'seat', line: lineOf('const seat') },
      { name: 'h1', line: lineOf('const h1') },
    ]);
  });

  it('reports no connectors for a feature that is not a hole', async () => {
    const { body } = await post({ sourceLocation: { filePath: plateFile, line: lineOf('fillet(0.5') }, dryRun: true });
    expect(body).toEqual({ success: true, dependents: [], connectors: [] });
  });
});
