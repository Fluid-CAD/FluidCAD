import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'http';
import { createEditorRouter, DirtyBufferState } from '../../src/routes/editor.ts';

let server: http.Server;
let baseUrl: string;
let state: DirtyBufferState;

describe('editor dirty-buffer route', () => {
  beforeAll(async () => {
    state = new DirtyBufferState();
    const app = express();
    app.use(express.json());
    app.use('/api', createEditorRouter(state));

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

  it('returns an empty list when nothing is dirty', async () => {
    state.setDirtyFiles([]);
    const res = await fetch(`${baseUrl}/api/editor/dirty-files`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(0);
  });

  it('reflects the most recent setDirtyFiles call', async () => {
    state.setDirtyFiles(['/tmp/a.fluid.js', '/tmp/b.fluid.js']);

    const res = await fetch(`${baseUrl}/api/editor/dirty-files`);
    expect(res.status).toBe(200);
    const body = await res.json() as { path: string; lastModifiedMs: number }[];
    expect(body.map((e) => e.path).sort()).toEqual(['/tmp/a.fluid.js', '/tmp/b.fluid.js']);
    for (const entry of body) {
      expect(typeof entry.lastModifiedMs).toBe('number');
    }
  });

  it('replaces the set wholesale on each update (not incremental)', async () => {
    state.setDirtyFiles(['/tmp/x.fluid.js', '/tmp/y.fluid.js']);
    state.setDirtyFiles(['/tmp/z.fluid.js']);

    const res = await fetch(`${baseUrl}/api/editor/dirty-files`);
    const body = await res.json() as { path: string }[];
    expect(body.map((e) => e.path)).toEqual(['/tmp/z.fluid.js']);
  });

  it('isDirty resolves a normalized lookup against the cached set', () => {
    state.setDirtyFiles(['/tmp/case/file.fluid.js']);
    expect(state.isDirty('/tmp/case/file.fluid.js')).toBe(true);
    expect(state.isDirty('/tmp/case/other.fluid.js')).toBe(false);
  });
});
