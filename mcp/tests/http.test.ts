import { describe, it, expect, afterEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildServer, createMcpHttpHandler, SERVER_INSTRUCTIONS, type McpHttpHandler } from '../src/server.ts';

let httpServer: http.Server | null = null;
let handler: McpHttpHandler | null = null;
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) {
    await client.close().catch(() => {});
  }
  await handler?.close();
  handler = null;
  if (httpServer) {
    httpServer.closeAllConnections();
    await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
    httpServer = null;
  }
});

// The engine's shape: a JSON body parser for the app, the handler on a route.
// `/raw` has no parser, so the handler reads the body itself.
async function startApp(h: McpHttpHandler): Promise<string> {
  const app = express();
  app.all('/raw', (req, res) => h.handle(req, res));
  app.use(express.json({ limit: '50mb' }));
  app.all('/mcp', (req, res) => h.handle(req, res));
  httpServer = http.createServer(app);
  await new Promise<void>((resolve) => httpServer!.listen(0, '127.0.0.1', () => resolve()));
  return `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
}

async function connect(url: string): Promise<Client> {
  const client = new Client({ name: 'http-test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  clients.push(client);
  return client;
}

describe('MCP over streamable HTTP', () => {
  it('initializes, lists tools and calls one', async () => {
    handler = createMcpHttpHandler({ buildServer: () => buildServer() });
    const base = await startApp(handler);

    for (const route of ['/mcp', '/raw']) {
      const client = await connect(`${base}${route}`);
      expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS);

      const { tools } = await client.listTools();
      expect(tools).toHaveLength(42);
      expect(tools.find((t) => t.name === 'write_file')?.annotations).toEqual({
        readOnlyHint: false,
        destructiveHint: true,
      });

      const result = await client.callTool({ name: 'read_skill', arguments: { name: 'fluidcad' } });
      expect(result.isError).not.toBe(true);
      expect(JSON.parse((result.content as any[])[0].text).name).toBe('fluidcad');
    }
    expect(handler.sessionCount).toBe(2);
  });

  it('refuses a request with no session that is not an initialize', async () => {
    handler = createMcpHttpHandler({ buildServer: () => buildServer() });
    const base = await startApp(handler);
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(res.status).toBe(400);
    const unknown = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': 'no-such-session',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(unknown.status).toBe(404);
  });

  it('delivers a client cancel to the gate, as the stateful transport should', async () => {
    let aborted = false;
    handler = createMcpHttpHandler({
      buildServer: () =>
        buildServer({
          toolGate: {
            before: (_call, signal) =>
              new Promise((resolve) => {
                signal.addEventListener('abort', () => {
                  aborted = true;
                  resolve({ allow: false, message: 'cancelled' });
                });
              }),
            after: () => {},
          },
        }),
    });
    const base = await startApp(handler);
    const client = await connect(`${base}/mcp`);
    const controller = new AbortController();
    const pending = client.callTool({ name: 'list_docs', arguments: {} }, undefined, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort('user cancelled');
    await expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(aborted).toBe(true));
  });

  it('close() ends every session, aborts running calls, and accepts a new initialize', async () => {
    let started = false;
    let aborted = false;
    handler = createMcpHttpHandler({
      buildServer: () =>
        buildServer({
          toolGate: {
            before: (_call, signal) =>
              new Promise((resolve) => {
                started = true;
                signal.addEventListener('abort', () => {
                  aborted = true;
                  resolve({ allow: false, message: 'closed' });
                });
              }),
            after: () => {},
          },
        }),
    });
    const base = await startApp(handler);
    const client = await connect(`${base}/mcp`);
    // Left pending: the client may wait to resume its closed stream; closing
    // the client in afterEach settles it.
    void client.callTool({ name: 'list_docs', arguments: {} }).catch(() => {});
    await vi.waitFor(() => expect(started).toBe(true));
    expect(handler.sessionCount).toBe(1);

    await handler.close();
    expect(handler.sessionCount).toBe(0);
    await vi.waitFor(() => expect(aborted).toBe(true));

    // The closed session is gone for its client...
    await expect(client.listTools()).rejects.toThrow();
    // ...and a new client starts a new one.
    const again = await connect(`${base}/mcp`);
    const { tools } = await again.listTools();
    expect(tools.length).toBe(42);
    expect(handler.sessionCount).toBe(1);
  });
});
