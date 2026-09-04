import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'http';
import { createExportRouter } from '../../src/routes/export.ts';

let server: http.Server;
let baseUrl: string;

/** Options each exportShapes call received. */
let exportCalls: Record<string, unknown>[];
/** (options, livePoses) each exportAssembly call received. */
let assemblyCalls: { options: Record<string, unknown>; livePoses: unknown }[];
/** What the fake engine answers an assembly export with. */
let assemblyOutcome: unknown;

const fakeServer = {
  exportShapes: (_shapeIds: string[], options: Record<string, unknown>) => {
    exportCalls.push(options);
    return { data: 'solid', fileName: 'export.stl' };
  },
  exportAssembly: (options: Record<string, unknown>, livePoses: unknown) => {
    assemblyCalls.push({ options, livePoses });
    return assemblyOutcome;
  },
};

const pose = (instanceId: string) => ({
  instanceId,
  position: { x: 1, y: 2, z: 3 },
  quaternion: { x: 0, y: 0, z: 0, w: 1 },
});

async function postExport(body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}/api/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // binary/plain export bodies are not JSON
  }
  return { status: res.status, body: parsed };
}

describe('export route', () => {
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', createExportRouter(fakeServer as any, '/ws'));

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
    exportCalls = [];
    assemblyCalls = [];
    assemblyOutcome = { ok: true, data: 'ISO-10303-21;', fileName: 'rig.step', posesSource: 'live' };
  });

  it('rejects a body with neither selector, or both', async () => {
    const neither = await postExport({ format: 'step' });
    expect(neither.status).toBe(400);
    expect(neither.body.error).toMatch(/shapeIds.*assembly/);
    const both = await postExport({ format: 'step', shapeIds: ['s1'], assembly: {} });
    expect(both.status).toBe(400);
    expect(exportCalls).toEqual([]);
    expect(assemblyCalls).toEqual([]);
  });

  it('exports the whole assembly with the client\'s live poses', async () => {
    const res = await fetch(`${baseUrl}/api/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ format: 'step', assembly: { poses: [pose('inst-0'), pose('inst-1')] }, includeColors: false }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-fluidcad-assembly-poses')).toBe('live');
    expect(res.headers.get('content-disposition')).toContain('filename="rig.step"');
    expect(await res.text()).toBe('ISO-10303-21;');
    expect(assemblyCalls).toHaveLength(1);
    expect(assemblyCalls[0].options.includeColors).toBe(false);
    expect(assemblyCalls[0].livePoses).toEqual([pose('inst-0'), pose('inst-1')]);
    expect(exportCalls).toEqual([]);
  });

  it('exports the assembly at its statement poses when none are sent', async () => {
    assemblyOutcome = { ok: true, data: 'ISO-10303-21;', fileName: 'rig.step', posesSource: 'statement' };
    const res = await fetch(`${baseUrl}/api/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ format: 'step', assembly: {} }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-fluidcad-assembly-poses')).toBe('statement');
    expect(assemblyCalls[0].livePoses).toBeUndefined();
  });

  it('rejects malformed live poses before touching the engine', async () => {
    const { status, body } = await postExport({
      format: 'step',
      assembly: { poses: [{ instanceId: 'inst-0', position: { x: 1, y: 2 }, quaternion: { x: 0, y: 0, z: 0, w: 1 } }] },
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/poses/);
    expect(assemblyCalls).toEqual([]);
  });

  it('relays the engine\'s refusal as 422', async () => {
    assemblyOutcome = { ok: false, reason: 'Exporting an assembly targets an assembly — open a *.assembly.js file first.' };
    const { status, body } = await postExport({ format: 'stl', assembly: {} });
    expect(status).toBe(422);
    expect(body.error).toMatch(/assembly\.js/);
  });

  it('answers 404 for an assembly export with nothing rendered', async () => {
    assemblyOutcome = null;
    const { status } = await postExport({ format: 'stl', assembly: {} });
    expect(status).toBe(404);
  });

  it('passes a valid STL scaleTo through', async () => {
    const { status } = await postExport({ format: 'stl', shapeIds: ['s1'], scaleTo: 'document' });
    expect(status).toBe(200);
    expect(exportCalls[0].scaleTo).toBe('document');
  });

  it('leaves scaleTo to the engine default when absent', async () => {
    const { status } = await postExport({ format: 'stl', shapeIds: ['s1'] });
    expect(status).toBe(200);
    expect('scaleTo' in exportCalls[0]).toBe(false);
  });

  it('rejects an unknown scaleTo', async () => {
    const { status, body } = await postExport({ format: 'stl', shapeIds: ['s1'], scaleTo: 'cubits' });
    expect(status).toBe(400);
    expect(body.error).toMatch(/scaleTo/);
    expect(exportCalls).toEqual([]);
  });

  it('ignores scaleTo for STEP', async () => {
    const { status } = await postExport({ format: 'step', shapeIds: ['s1'], scaleTo: 'document' });
    expect(status).toBe(200);
    expect('scaleTo' in exportCalls[0]).toBe(false);
  });

  it('never lets the client assert the shapes\' unit', async () => {
    await postExport({ format: 'step', shapeIds: ['s1'], unit: 'in' });
    expect('unit' in exportCalls[0]).toBe(false);
  });
});
