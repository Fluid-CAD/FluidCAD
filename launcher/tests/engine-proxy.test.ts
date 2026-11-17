import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEngineProxy } from '../src/server/engine-proxy';
import { eventually } from './fake-package';

/**
 * The proxy in front of an engine, over real HTTP: a fake engine behind it,
 * and a page that calls through it and, for an event stream, goes away.
 */

let engine: http.Server;
let front: http.Server;
/** Every request the fake engine got, and whether it has closed. */
let seen: { path: string; closed: boolean }[];

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
}

function close(server: http.Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

beforeEach(async () => {
  seen = [];
  engine = http.createServer((request, response) => {
    const entry = { path: request.url ?? '', closed: false };
    seen.push(entry);
    response.on('close', () => {
      entry.closed = true;
    });
    if (request.url === '/events') {
      // An event stream: headers and a first event, then held open.
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('event: hello\ndata: {}\n\n');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('engine says hi');
  });
  const enginePort = await listen(engine);
  const proxy = createEngineProxy({
    targetFor: (id) => (id === 'demo' ? { port: enginePort } : null),
    startPageFor: () => null,
    signedIn: () => true,
    sameOrigin: () => true,
  });
  const app = express();
  app.use(proxy.handler);
  front = http.createServer(app);
  await listen(front);
});

afterEach(async () => {
  await close(front);
  await close(engine);
});

function frontUrl(path: string): string {
  return `http://127.0.0.1:${(front.address() as AddressInfo).port}${path}`;
}

describe('engine proxy', () => {
  it('forwards a whole response and leaves it to finish', async () => {
    const response = await fetch(frontUrl('/p/demo/hello'));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('engine says hi');
    expect(seen.map((each) => each.path)).toEqual(['/hello']);
  });

  it('closes the engine request when the page goes away from an event stream', async () => {
    const request = http.get(frontUrl('/p/demo/events'));
    const firstChunk = await new Promise<string>((resolve, reject) => {
      request.on('error', reject);
      request.on('response', (response) => {
        expect(response.headers['content-type']).toBe('text/event-stream');
        response.once('data', (chunk: Buffer) => resolve(chunk.toString()));
      });
    });
    expect(firstChunk).toContain('event: hello');
    expect(seen).toHaveLength(1);
    expect(seen[0].closed).toBe(false);

    request.on('error', () => {});
    request.destroy();

    await eventually(() => seen[0].closed, 5_000);
  });
});
