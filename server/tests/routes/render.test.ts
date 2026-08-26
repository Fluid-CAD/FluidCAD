// POST /api/render is the in-page editor host's `live-update`. The one flag
// it carries beyond `filePath` + `code` is `keepCurrent`: a host that just
// applied an edit to a file other than the rendered model (the mate dialog
// writing a connector() into a PART file while the assembly is on screen)
// must be able to say "fold this in as a dependency, don't switch the
// viewport" — the same flag the IPC hosts put on `live-update`.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'http';
import { createRenderRouter, type RenderOutcome } from '../../src/routes/render.ts';

let server: http.Server;
let baseUrl: string;
let calls: { fileName: string; code: string; keepCurrent: boolean }[] = [];

async function post(body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}/api/render`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe('POST /api/render', () => {
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', createRenderRouter(async (fileName, code, keepCurrent): Promise<RenderOutcome> => {
      calls.push({ fileName, code, keepCurrent });
      return { state: 'rendered', version: 1, absPath: fileName, durationMs: 0 };
    }));
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    calls = [];
  });

  it('renders the file as the current model by default', async () => {
    const { status, body } = await post({ filePath: '/ws/robot.assembly.js', code: '// a' });
    expect(status).toBe(200);
    expect(body.state).toBe('rendered');
    expect(calls).toEqual([{ fileName: '/ws/robot.assembly.js', code: '// a', keepCurrent: false }]);
  });

  it('forwards keepCurrent so a cross-file edit folds in as a dependency', async () => {
    await post({ filePath: '/ws/arm.part.js', code: '// b', keepCurrent: true });
    expect(calls[0]?.keepCurrent).toBe(true);
  });

  it('treats anything but boolean true as false', async () => {
    await post({ filePath: '/ws/arm.part.js', code: '// c', keepCurrent: 'yes' });
    expect(calls[0]?.keepCurrent).toBe(false);
  });

  it('still validates filePath and code', async () => {
    expect((await post({ code: '// d' })).status).toBe(400);
    expect((await post({ filePath: '/ws/a.part.js' })).status).toBe(400);
    expect(calls).toEqual([]);
  });
});
