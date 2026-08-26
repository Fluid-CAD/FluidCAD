import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'http';
import { WebSocket } from 'ws';
import { createServerCore } from '../src/server-core.ts';
import { HostRegistry } from '../src/host-registry.ts';
import { attachEditorHostTransport } from '../src/editor-host-transport.ts';
import { FeatureEditDispatcher } from '../src/edit-dispatch.ts';
import { createEditorRouter, DirtyBufferState } from '../src/routes/editor.ts';

// The in-page editor host is a third implementation of the host contract, over
// the WebSocket the page already has. This exercises the whole loop a browser
// host runs: say hello, receive an edit, settle its ack — with no IPC channel
// anywhere.

let server: http.Server;
let baseUrl: string;
let wsUrl: string;
let hosts: HostRegistry;
let dispatcher: FeatureEditDispatcher;
let dirtyBufferState: DirtyBufferState;
/** Stands in for the IPC pipe; false = this process was not forked by an editor. */
let ipcAttached: boolean;
let ipcMessages: any[];
let sockets: WebSocket[];

const SPEC = { feature: 'fillet', value: 4, filePath: '/ws/m.fluid.js', producers: [], parts: [], imports: [] };

async function post(route: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}/api${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

/** A page connected to the server, collecting everything it is sent. */
type Client = { ws: WebSocket; received: any[] };

async function connect(): Promise<Client> {
  const ws = new WebSocket(wsUrl);
  sockets.push(ws);
  const client: Client = { ws, received: [] };
  ws.on('message', (raw) => { client.received.push(JSON.parse(String(raw))); });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return client;
}

async function untilReceived(client: Client, type: string, timeoutMs = 2000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = client.received.find((m) => m.type === type);
    if (hit) {
      return hit;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`no ${type}; saw ${JSON.stringify(client.received)}`);
}

async function hello(client: Client, capabilities = { undoRedo: true }): Promise<void> {
  client.ws.send(JSON.stringify({ type: 'editor-hello', editor: 'monaco', capabilities }));
  await untilReceived(client, 'editor-capabilities');
}

describe('in-page editor host transport', () => {
  beforeEach(async () => {
    ipcAttached = false;
    ipcMessages = [];
    sockets = [];
    hosts = new HostRegistry((msg) => {
      if (!ipcAttached) {
        return false;
      }
      ipcMessages.push(msg);
      return true;
    });
    dispatcher = new FeatureEditDispatcher(
      { getCurrentFileName: () => null, getCurrentCode: () => null } as any,
      (msg) => hosts.send(msg),
      { preflight: false, ackTimeoutMs: 400 },
    );
    dirtyBufferState = new DirtyBufferState();

    const app = express();
    app.use(express.json());
    app.use('/api', createEditorRouter(dirtyBufferState, dispatcher));
    // Stands in for the 24 routers that write source; all of them dispatch
    // through the one shared dispatcher, so one is enough to prove the pipe.
    app.post('/api/test/dispatch', async (_req, res) => {
      await dispatcher.dispatch(res, SPEC as any, { success: true });
    });

    server = http.createServer(app);
    const core = createServerCore(server);
    attachEditorHostTransport({ core, hosts, dispatcher, dirtyBufferState });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
    wsUrl = `ws://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    for (const ws of sockets) {
      ws.close();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('announces capabilities to every client when a page says hello', async () => {
    const client = await connect();
    client.ws.send(JSON.stringify({ type: 'editor-hello', editor: 'monaco', capabilities: { undoRedo: true } }));
    expect(await untilReceived(client, 'editor-capabilities')).toMatchObject({ undoRedo: true });
  });

  it('delivers a dispatched edit to the page and settles it over POST /api/editor/ack', async () => {
    const client = await connect();
    await hello(client);

    const pending = post('/test/dispatch', {});
    const envelope = await untilReceived(client, 'host-message');
    expect(envelope.message.type).toBe('apply-feature-edit');
    expect(envelope.message.spec).toMatchObject({ feature: 'fillet' });
    const editId = envelope.message.spec.editId;
    expect(typeof editId).toBe('string');

    const ack = await post('/editor/ack', { editId });
    expect(ack.status).toBe(200);

    const { status, body } = await pending;
    expect(status).toBe(200);
    expect(body).toMatchObject({ success: true });
  });

  it('carries an edit failure back as the route response', async () => {
    const client = await connect();
    await hello(client);

    const pending = post('/test/dispatch', {});
    const envelope = await untilReceived(client, 'host-message');
    await post('/editor/ack', { editId: envelope.message.spec.editId, error: 'the line moved' });

    const { status, body } = await pending;
    expect(status).toBe(422);
    expect(body.reason).toBe('the line moved');
  });

  it('settles undo through the WebSocket edit-ack, the way an IPC host does', async () => {
    const client = await connect();
    await hello(client);

    const pending = post('/editor/undo', { filePath: '/ws/m.fluid.js' });
    const envelope = await untilReceived(client, 'host-message');
    expect(envelope.message.type).toBe('undo');
    expect(envelope.message.filePath).toBe('/ws/m.fluid.js');

    client.ws.send(JSON.stringify({ type: 'edit-ack', editId: envelope.message.editId }));
    const { status, body } = await pending;
    expect(status).toBe(200);
    expect(body).toMatchObject({ success: true });
  });

  it('feeds the dirty-buffer guard the MCP tools read', async () => {
    const client = await connect();
    await hello(client);

    client.ws.send(JSON.stringify({ type: 'editor-dirty-state', dirtyFiles: ['/ws/a.fluid.js'] }));
    for (let i = 0; i < 100 && !dirtyBufferState.isDirty('/ws/a.fluid.js'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(dirtyBufferState.isDirty('/ws/a.fluid.js')).toBe(true);

    const res = await fetch(`${baseUrl}/api/editor/dirty-files`);
    expect((await res.json() as any[]).map((e) => e.path)).toEqual(['/ws/a.fluid.js']);
  });

  it('sends edits to the IPC host, not the page, when an extension is attached', async () => {
    ipcAttached = true;
    hosts.announce('ipc', { undoRedo: true }); // what the extension's IPC hello does
    const client = await connect();
    await hello(client);

    const pending = post('/editor/undo', { filePath: '/ws/m.fluid.js' });
    for (let i = 0; i < 100 && ipcMessages.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(ipcMessages).toHaveLength(1);
    expect(client.received.some((m) => m.type === 'host-message')).toBe(false);

    dispatcher.settle(ipcMessages[0].editId, undefined);
    expect((await pending).status).toBe(200);
  });

  it('stops hosting when the page disconnects, and says so', async () => {
    const hosting = await connect();
    const observer = await connect();
    await hello(hosting);
    await untilReceived(observer, 'editor-capabilities');
    observer.received.length = 0;

    hosting.ws.close();
    expect(await untilReceived(observer, 'editor-capabilities')).toMatchObject({ undoRedo: false });

    // With nothing hosting, undo is an honest failure rather than a silent
    // success — exactly the no-host behaviour that predates this transport.
    const { status, body } = await post('/editor/undo', { filePath: '/ws/m.fluid.js' });
    expect(status).toBe(503);
    expect(body.reason).toContain('no editor');
  });

  it('leaves a server with no host attached behaving exactly as before', async () => {
    // A plain viewer client that never says hello is not a host.
    const client = await connect();

    const dispatched = await post('/test/dispatch', {});
    expect(dispatched.status).toBe(200);
    expect(dispatched.body).toMatchObject({ success: true }); // legacy immediate success
    expect(client.received.some((m) => m.type === 'host-message')).toBe(false);
    expect(client.received.some((m) => m.type === 'editor-capabilities')).toBe(false);

    const undone = await post('/editor/undo', { filePath: '/ws/m.fluid.js' });
    expect(undone.status).toBe(503);
  });

  it('replays capabilities to a client that connects after the hello', async () => {
    const first = await connect();
    await hello(first);

    const late = await connect();
    expect(await untilReceived(late, 'editor-capabilities')).toMatchObject({ undoRedo: true });
  });
});
