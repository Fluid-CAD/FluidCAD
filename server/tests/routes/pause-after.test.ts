import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTimelineRouter } from '../../src/routes/timeline.ts';
import { applyFeatureEdit } from '../../src/apply-feature-edit/index.ts';
import { FeatureEditDispatcher } from '../../src/edit-dispatch.ts';
import type { FluidCadServer } from '../../src/fluidcad-server/index.ts';

// The edit-feature gesture's pause, acknowledged: `/pause-after` places the
// breakpoint after the statement through the shared dispatcher and answers
// with whether the buffer changed (a stop already there is a no-op, and no
// render follows) and the render version current at the ack — what the
// dialog's session waits past before rolling its view back.

const CODE = "import { extrude, fillet, breakpoint } from 'fluidcad/core';\nextrude(5);\nbreakpoint();\nfillet(2);\n";
const FILE = '/model.part.js';

function harness(opts: { dispatcher?: Partial<FeatureEditDispatcher> | null; renderVersion?: number } = {}) {
  const server = {
    getCurrentCode: () => CODE, getCurrentFileName: () => FILE, getActiveBreakpoint: () => ({ line: 3, column: 1 }),
  } as unknown as FluidCadServer;
  const send = vi.fn(async (spec) => {
    const result = await applyFeatureEdit(CODE, spec);
    return result.error ? { error: result.error } : { changed: result.newCode !== CODE };
  });
  const dispatcher = opts.dispatcher === null ? undefined
    : { send, ...(opts.dispatcher ?? {}) } as unknown as FeatureEditDispatcher;
  const router = createTimelineRouter(server, vi.fn(), vi.fn(), {
    dispatcher,
    ...(opts.renderVersion !== undefined ? { renderVersion: () => opts.renderVersion! } : {}),
  });
  const handler = router.stack.find(layer => layer.route?.path === '/pause-after')!.route.stack[0].handle;
  async function post(body: unknown) {
    const res = { statusCode: 200, body: undefined as any,
      status(code: number) { this.statusCode = code; return this; },
      json(value: unknown) { this.body = value; return this; } };
    await handler({ body } as any, res as any, vi.fn());
    return res;
  }
  return { post, send };
}

describe('pause-after route', () => {
  it('dispatches the pause as an acknowledged edit and reports the changed buffer', async () => {
    const h = harness({ renderVersion: 12 });
    const response = await h.post({ sourceLocation: { filePath: FILE, line: 4, column: 1 } });
    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ success: true, changed: true, renderVersion: 12 });
    const spec = h.send.mock.calls[0][0];
    expect(spec).toMatchObject({ filePath: FILE, pauseAfter: { referenceRow: 3 } });
  });

  it('lifts the stop an open dialog holds the build on, in the same edit, when asked', async () => {
    const h = harness({ renderVersion: 12 });
    const response = await h.post({ sourceLocation: { filePath: FILE, line: 4, column: 1 }, liftActive: true });
    expect(response.body).toEqual({ success: true, changed: true, renderVersion: 12 });
    expect(h.send.mock.calls[0][0].pauseAfter).toEqual({ referenceRow: 3, lift: { line: 3, column: 1 } });
  });

  it('lifts nothing unless asked', async () => {
    const h = harness();
    await h.post({ sourceLocation: { filePath: FILE, line: 4, column: 1 } });
    expect(h.send.mock.calls[0][0].pauseAfter).toEqual({ referenceRow: 3 });
  });

  it('reports a stop already there as unchanged — no render will follow', async () => {
    const h = harness({ renderVersion: 12 });
    const response = await h.post({ sourceLocation: { filePath: FILE, line: 2, column: 1 } });
    expect(response.body).toEqual({ success: true, changed: false, renderVersion: 12 });
  });

  it('reports a host that does not say as unchanged, and no counter as 0', async () => {
    const h = harness({ dispatcher: { send: vi.fn(async () => ({})) } });
    const response = await h.post({ sourceLocation: { filePath: FILE, line: 4, column: 1 } });
    expect(response.body).toEqual({ success: true, changed: false, renderVersion: 0 });
  });

  it('relays a refusal', async () => {
    const h = harness({ dispatcher: { send: vi.fn(async () => ({ error: 'the editor did not answer' })) } });
    const response = await h.post({ sourceLocation: { filePath: FILE, line: 4, column: 1 } });
    expect(response.statusCode).toBe(422);
    expect(response.body).toEqual({ success: false, reason: 'the editor did not answer' });
  });

  it('needs a dispatcher', async () => {
    const h = harness({ dispatcher: null });
    expect((await h.post({ sourceLocation: { filePath: FILE, line: 4, column: 1 } })).statusCode).toBe(503);
  });

  it.each([undefined, {}, { sourceLocation: { line: 4 } }, { sourceLocation: { filePath: FILE, line: 0 } },
    { sourceLocation: { filePath: FILE, line: 1.5 } }])('rejects %j', async (body) => {
    const h = harness();
    expect((await h.post(body)).statusCode).toBe(400);
    expect(h.send).not.toHaveBeenCalled();
  });
});

describe('pauseAfter spec', () => {
  it('inserts the breakpoint after the statement and keeps the other stops', async () => {
    const result = await applyFeatureEdit(CODE, {
      feature: 'sketch', filePath: FILE, producers: [], parts: [], imports: [], pauseAfter: { referenceRow: 3 },
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe("import { extrude, fillet, breakpoint } from 'fluidcad/core';\nextrude(5);\nbreakpoint();\nfillet(2);\nbreakpoint();\n");
  });

  it('leaves the code alone when a stop already follows the statement', async () => {
    const result = await applyFeatureEdit(CODE, {
      feature: 'sketch', filePath: FILE, producers: [], parts: [], imports: [], pauseAfter: { referenceRow: 1 },
    });
    expect(result.newCode).toBe(CODE);
  });
});

describe('pauseAfter spec with a lift', () => {
  const spec = (referenceRow: number, lift: { line: number; column: number } | null) => ({
    feature: 'sketch' as const, filePath: FILE, producers: [], parts: [], imports: [], pauseAfter: { referenceRow, lift },
  });

  it('moves the open dialog\'s stop to the new row in one edit', async () => {
    // Paused after extrude (line 3); the gesture lands on fillet (row 3).
    const result = await applyFeatureEdit(CODE, spec(3, { line: 3, column: 1 }));
    expect(result.newCode).toBe("import { extrude, fillet, breakpoint } from 'fluidcad/core';\nextrude(5);\nfillet(2);\nbreakpoint();\n");
  });

  it('places the new stop on the row the lift moved up to', async () => {
    const code = "import { extrude, fillet, chamfer, breakpoint } from 'fluidcad/core';\nextrude(5);\nbreakpoint();\nfillet(2);\nchamfer(1);\n";
    // The lift is above the referenced row (chamfer, row 4): after it the row is 3.
    const result = await applyFeatureEdit(code, spec(4, { line: 3, column: 1 }));
    expect(result.newCode).toBe("import { extrude, fillet, chamfer, breakpoint } from 'fluidcad/core';\nextrude(5);\nfillet(2);\nchamfer(1);\nbreakpoint();\n");
  });

  it('leaves the code alone when the lifted stop is the one the row would get', async () => {
    const result = await applyFeatureEdit(CODE, spec(1, { line: 3, column: 1 }));
    expect(result.newCode).toBe(CODE);
  });

  it('keeps a stop the user set further down', async () => {
    const code = `${CODE}chamfer(1);\nbreakpoint();\n`;
    const result = await applyFeatureEdit(code, spec(3, { line: 3, column: 1 }));
    // (The blank line is how `addBreakpoint` always separates a new stop from a following statement.)
    expect(result.newCode).toBe("import { extrude, fillet, breakpoint } from 'fluidcad/core';\nextrude(5);\nfillet(2);\nbreakpoint();\n\nchamfer(1);\nbreakpoint();\n");
  });

  it('never lifts another stop in place of one that is not there', async () => {
    const result = await applyFeatureEdit(CODE, spec(3, { line: 9, column: 1 }));
    expect(result.newCode).toBe("import { extrude, fillet, breakpoint } from 'fluidcad/core';\nextrude(5);\nbreakpoint();\nfillet(2);\nbreakpoint();\n");
  });

  it('is a plain pause without a lift', async () => {
    const result = await applyFeatureEdit(CODE, spec(3, null));
    expect(result.newCode).toBe("import { extrude, fillet, breakpoint } from 'fluidcad/core';\nextrude(5);\nbreakpoint();\nfillet(2);\nbreakpoint();\n");
  });
});

describe('dispatcher changed flag', () => {
  function dispatcher() {
    const sent: any[] = [];
    const d = new FeatureEditDispatcher({ getCurrentFileName: () => '/other.part.js' } as unknown as FluidCadServer,
      (msg) => { sent.push(msg); return true; }, { preflight: false, ackTimeoutMs: 1000 });
    return { d, sent };
  }
  const spec = { feature: 'sketch' as const, filePath: FILE, producers: [], parts: [], imports: [], pauseAfter: { referenceRow: 3 } };

  it('carries the host round-trip verdict on whether the buffer changed', async () => {
    const { d, sent } = dispatcher();
    const pending = d.send(spec);
    d.settle(sent[0].spec.editId, undefined, true);
    expect(await pending).toEqual({ changed: true });
  });

  it('answers without the flag when the host did not say', async () => {
    const { d, sent } = dispatcher();
    const pending = d.send(spec);
    d.settle(sent[0].spec.editId, undefined);
    expect(await pending).toEqual({});
  });

  it('keeps a refusal a refusal', async () => {
    const { d, sent } = dispatcher();
    const pending = d.send(spec);
    d.settle(sent[0].spec.editId, 'nope', false);
    expect(await pending).toEqual({ error: 'nope' });
  });
});

// The whole round trip with the real dispatcher and a stand-in host: the
// host posts its buffer to /code/apply-feature like the in-page editor does,
// and the pause's answer carries the verdict the transform reached there.
import express from 'express';
import http from 'http';
import { createApplyFeatureRouter } from '../../src/routes/apply-feature/index.ts';

describe('pause-after through the editor round trip', () => {
  let server: http.Server;
  let baseUrl: string;
  let buffer = CODE;
  const relayed: any[] = [];
  const fakeServer = {
    getCurrentCode: () => buffer,
    getCurrentFileName: () => FILE,
    getLiveBuffer: () => buffer,
  };

  async function pauseAfter(line: number): Promise<any> {
    const pending = fetch(`${baseUrl}/api/pause-after`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceLocation: { filePath: FILE, line, column: 1 } }),
    }).then(res => res.json());
    // Play the host: apply the relayed spec against the buffer.
    let handled = relayed.length;
    while (relayed.length === handled) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    const msg = relayed[handled];
    const res = await fetch(`${baseUrl}/api/code/apply-feature`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: buffer, spec: msg.spec }),
    });
    const result = await res.json();
    if (typeof result.newCode === 'string' && !result.error) {
      buffer = result.newCode;
    }
    return pending;
  }

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    const send = (msg: any) => { relayed.push(msg); return true; };
    const dispatcher = new FeatureEditDispatcher(fakeServer as any, send, { ackTimeoutMs: 500 });
    app.use('/api', createTimelineRouter(fakeServer as any, send, () => {}, { dispatcher, renderVersion: () => 3 }));
    app.use('/api', createApplyFeatureRouter(fakeServer as any, send, { dispatcher }));
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it('says the buffer changed the first time and not the second', async () => {
    expect(await pauseAfter(4)).toEqual({ success: true, changed: true, renderVersion: 3 });
    expect(buffer).toBe("import { extrude, fillet, breakpoint } from 'fluidcad/core';\nextrude(5);\nbreakpoint();\nfillet(2);\nbreakpoint();\n");
    expect(await pauseAfter(4)).toEqual({ success: true, changed: false, renderVersion: 3 });
  });
});
