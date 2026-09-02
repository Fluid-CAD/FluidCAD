import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'http';
import { createExportRouter } from '../../src/routes/export.ts';

let server: http.Server;
let baseUrl: string;

/** Options each exportShapes call received. */
let exportCalls: Record<string, unknown>[];

const fakeServer = {
  exportShapes: (_shapeIds: string[], options: Record<string, unknown>) => {
    exportCalls.push(options);
    return { data: 'solid', fileName: 'export.stl' };
  },
};

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
