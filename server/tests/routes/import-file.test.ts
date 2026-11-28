import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'http';
import { createSketchEditsRouter } from '../../src/routes/sketch-edits.ts';

let server: http.Server;
let baseUrl: string;

/** Messages the route relayed to the editor host. */
let relayed: any[];
/** Arguments each importFile call received. */
let importCalls: { workspacePath: string; fileName: string }[];
/** Per-test failure to throw out of importFile; reset to null. */
let importError: Error | null;
/** What importFile reports back; undefined mimics an older engine. */
let importReport: { solidCount: number; unit: string; sourceUnits: { length: string[]; angle: string[] } } | undefined;

/** The model the server has open; '' is none. Reset to a part file. */
let currentFile: string;

const WORKSPACE = '/ws';

const fakeServer = {
  getCurrentFileName: () => currentFile,
  importFile: (workspacePath: string, fileName: string, _data: string) => {
    importCalls.push({ workspacePath, fileName });
    if (importError) {
      throw importError;
    }
    return importReport;
  },
};

async function postImport(body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}/api/import-file`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe('import-file route', () => {
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', createSketchEditsRouter(
      fakeServer as any,
      (msg) => relayed.push(msg),
      WORKSPACE,
    ));

    server = http.createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  beforeEach(() => {
    relayed = [];
    importCalls = [];
    importError = null;
    importReport = undefined;
    currentFile = '/ws/model.fluid.js';
  });

  it('reports the solid count and the file\'s declared units', async () => {
    importReport = { solidCount: 2, unit: 'mm', sourceUnits: { length: ['INCH'], angle: ['DEGREE'] } };
    const { status, body } = await postImport({ fileName: 'bracket.step', data: 'AAAA' });
    expect(status).toBe(200);
    expect(body).toEqual({
      success: true,
      fileName: 'bracket',
      solidCount: 2,
      sourceUnits: { length: ['INCH'], angle: ['DEGREE'] },
    });
  });

  it('tells the editor to insert the load call for the active file', async () => {
    const { status, body } = await postImport({ fileName: 'bracket.step', data: 'AAAA' });
    expect(status).toBe(200);
    expect(body).toEqual({ success: true, fileName: 'bracket' });
    expect(relayed).toEqual([
      { type: 'insert-load', filePath: '/ws/model.fluid.js', fileName: 'bracket' },
    ]);
  });

  it('passes the active part on, so the load call lands in its body', async () => {
    currentFile = '/ws/plate.part.js';
    await postImport({
      fileName: 'bracket.step',
      data: 'AAAA',
      part: { filePath: '/ws/plate.part.js', line: 3, column: 21 },
    });
    expect(relayed).toEqual([
      { type: 'insert-load', filePath: '/ws/plate.part.js', fileName: 'bracket', part: { line: 3, column: 21 } },
    ]);
  });

  it('drops an active part that belongs to another file', async () => {
    await postImport({
      fileName: 'bracket.step',
      data: 'AAAA',
      part: { filePath: '/ws/other.part.js', line: 3, column: 0 },
    });
    expect(relayed).toEqual([
      { type: 'insert-load', filePath: '/ws/model.fluid.js', fileName: 'bracket' },
    ]);
  });

  it('refuses a malformed active part', async () => {
    const { status } = await postImport({ fileName: 'bracket.step', data: 'AAAA', part: { line: 3 } });
    expect(status).toBe(400);
    expect(importCalls).toEqual([]);
    expect(relayed).toEqual([]);
  });

  it('refuses with no model open, before anything is imported', async () => {
    currentFile = '';
    const { status, body } = await postImport({ fileName: 'bracket.step', data: 'AAAA' });
    expect(status).toBe(409);
    expect(body.error).toMatch(/^Open a part first/);
    expect(importCalls).toEqual([]);
    expect(relayed).toEqual([]);
  });

  it('refuses while an assembly is the open model: load() would break it', async () => {
    currentFile = '/ws/robot.assembly.js';
    const { status, body } = await postImport({ fileName: 'bracket.step', data: 'AAAA' });
    expect(status).toBe(409);
    expect(body.error).toMatch(/not an assembly/);
    expect(importCalls).toEqual([]);
    expect(relayed).toEqual([]);
  });

  it('strips the .stp extension for the load name', async () => {
    await postImport({ fileName: 'Plate.STP', data: 'AAAA' });
    expect(relayed[0].fileName).toBe('Plate');
  });

  it('does not ask for an insert when the import fails', async () => {
    importError = new Error('bad STEP');
    const { status } = await postImport({ fileName: 'bracket.step', data: 'AAAA' });
    expect(status).toBe(500);
    expect(relayed).toEqual([]);
  });

  it('does not ask for an insert when the body is invalid', async () => {
    const { status } = await postImport({ fileName: 42 });
    expect(status).toBe(400);
    expect(importCalls).toEqual([]);
    expect(relayed).toEqual([]);
  });
});
