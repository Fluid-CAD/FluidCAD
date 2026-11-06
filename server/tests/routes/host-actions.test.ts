import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import http from 'http';
import net from 'net';
import { createHostActionsRouter } from '../../src/routes/host-actions.ts';

/**
 * `POST /api/host/open-external` (hub-plan H11): a framed page (VS Code's
 * webview) asks the attached editor host to open a web page in the user's
 * browser. The host send is a fake that records what it was handed.
 */

let servers: http.Server[] = [];

async function serve(send: (msg: any) => boolean, hasHost = true): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use('/api', createHostActionsRouter({ send, hasHost: () => hasHost }));
  const server = http.createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return `http://127.0.0.1:${(server.address() as net.AddressInfo).port}/api`;
}

async function post(base: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}/host/open-external`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

afterEach(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  servers = [];
});

describe('POST /api/host/open-external', () => {
  it('hands the host an open-external message with the canonical URL, and says whether a host took it', async () => {
    const sent: any[] = [];
    const base = await serve((msg) => {
      sent.push(msg);
      return true;
    });
    const res = await post(base, { url: 'http://localhost:8787/@acme/feature-tests?model=parts/pcb-plate.part.js' });
    expect(res).toEqual({ status: 200, body: { delivered: true } });
    expect(sent).toEqual([{ type: 'open-external', url: 'http://localhost:8787/@acme/feature-tests?model=parts/pcb-plate.part.js' }]);

    const nobody = await serve(() => false);
    expect((await post(nobody, { url: 'https://hub.fluidcad.io/@acme/kit' })).body).toEqual({ delivered: false });
  });

  it('sends nothing and says so when no editor host announced itself (a bare `fluidcad serve` IPC channel opens nothing)', async () => {
    const sent: any[] = [];
    const base = await serve((msg) => {
      sent.push(msg);
      return true;
    }, false);
    expect((await post(base, { url: 'https://hub.fluidcad.io/@acme/kit' })).body).toEqual({ delivered: false });
    expect(sent).toEqual([]);
  });

  it('refuses anything but an http(s) URL, and sends nothing', async () => {
    const sent: any[] = [];
    const base = await serve((msg) => {
      sent.push(msg);
      return true;
    });
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'not a url', 42, null, `https://x.example/${'a'.repeat(5000)}`]) {
      const res = await post(base, { url });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('bad-request');
    }
    expect(sent).toEqual([]);
  });
});
