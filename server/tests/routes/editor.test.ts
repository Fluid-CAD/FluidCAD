import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'http';
import { createEditorRouter, DirtyBufferState } from '../../src/routes/editor.ts';
import { FeatureEditDispatcher } from '../../src/edit-dispatch.ts';

let server: http.Server;
let baseUrl: string;
let state: DirtyBufferState;

describe('editor dirty-buffer route', () => {
  beforeAll(async () => {
    state = new DirtyBufferState();
    // The dirty-files route never dispatches; a host-less dispatcher satisfies
    // the signature.
    const dispatcher = new FeatureEditDispatcher({} as any, () => false, { ackTimeoutMs: 100 });
    const app = express();
    app.use(express.json());
    app.use('/api', createEditorRouter(state, dispatcher));

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

  it('keeps each editor’s set apart: wholesale per source, the union listed, one forgotten alone', () => {
    state.setDirtyFiles(['/tmp/a.fluid.js'], 'ui:1');
    state.setDirtyFiles(['/tmp/b.fluid.js', '/tmp/a.fluid.js'], 'ui:2');
    state.setDirtyFiles(['/tmp/c.fluid.js']);
    expect(state.list().map((e) => e.path).sort()).toEqual(['/tmp/a.fluid.js', '/tmp/b.fluid.js', '/tmp/c.fluid.js']);
    state.setDirtyFiles(['/tmp/b.fluid.js'], 'ui:2');
    expect(state.isDirty('/tmp/a.fluid.js')).toBe(true);
    expect(state.forget('ui:1')).toBe(true);
    expect(state.isDirty('/tmp/a.fluid.js')).toBe(false);
    expect(state.list().map((e) => e.path).sort()).toEqual(['/tmp/b.fluid.js', '/tmp/c.fluid.js']);
    expect(state.forget('ui:1')).toBe(false);
  });
});
