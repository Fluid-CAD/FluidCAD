import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'http';
import { createEditorRouter, DirtyBufferState } from '../../src/routes/editor.ts';
import { FeatureEditDispatcher } from '../../src/edit-dispatch.ts';

// The undo/redo routes delegate to the attached editor's native history: the
// server relays the action over IPC and answers with the editor's `edit-ack`.
// Unlike apply-feature dispatch there is no legacy fire-and-forget success —
// no host means no history to step, so the route reports it honestly.
let server: http.Server;
let baseUrl: string;
let dispatcher: FeatureEditDispatcher;

let relayed: any[];
/** What sendToExtension reports: true = a host process received the message. */
let delivered: boolean;

async function postAction(
  action: 'undo' | 'redo',
  body: unknown,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}/api/editor/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function untilRelayed(): Promise<any> {
  for (let i = 0; i < 100; i++) {
    if (relayed.length > 0) {
      return relayed[0];
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('nothing was relayed to the extension');
}

describe('editor undo/redo dispatch', () => {
  beforeAll(async () => {
    dispatcher = new FeatureEditDispatcher(
      {} as any,
      (msg) => {
        relayed.push(msg);
        return delivered;
      },
      { ackTimeoutMs: 300 },
    );
    const app = express();
    app.use(express.json());
    app.use('/api', createEditorRouter(new DirtyBufferState(), dispatcher));

    server = http.createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    relayed = [];
    delivered = true;
  });

  it('refuses a request without a filePath', async () => {
    const { status } = await postAction('undo', {});
    expect(status).toBe(400);
    expect(relayed).toEqual([]);
  });

  it('relays the action with an editId and answers success on a clean ack', async () => {
    const pending = postAction('undo', { filePath: '/ws/m.fluid.js' });
    const msg = await untilRelayed();
    expect(msg.type).toBe('undo');
    expect(msg.filePath).toBe('/ws/m.fluid.js');
    expect(typeof msg.editId).toBe('string');

    dispatcher.settle(msg.editId, undefined);
    const { status, body } = await pending;
    expect(status).toBe(200);
    expect(body).toMatchObject({ success: true });
  });

  it('relays redo as its own action type', async () => {
    const pending = postAction('redo', { filePath: '/ws/m.fluid.js' });
    const msg = await untilRelayed();
    expect(msg.type).toBe('redo');

    dispatcher.settle(msg.editId, undefined);
    const { status } = await pending;
    expect(status).toBe(200);
  });

  it("answers the editor's error when the ack carries one", async () => {
    const pending = postAction('undo', { filePath: '/ws/m.fluid.js' });
    const msg = await untilRelayed();

    dispatcher.settle(msg.editId, 'Nothing to undo.');
    const { status, body } = await pending;
    expect(status).toBe(422);
    expect(body.success).toBe(false);
    expect(body.reason).toBe('Nothing to undo.');
  });

  it('reports a timeout when the editor never acks', async () => {
    const { status, body } = await postAction('undo', { filePath: '/ws/m.fluid.js' });
    expect(status).toBe(504);
    expect(body.success).toBe(false);
    expect(body.reason).toContain('did not answer');
  });

  it('fails honestly when no host process is attached', async () => {
    delivered = false;
    const { status, body } = await postAction('undo', { filePath: '/ws/m.fluid.js' });
    expect(status).toBe(503);
    expect(body.success).toBe(false);
    expect(body.reason).toContain('no editor');
  });
});
