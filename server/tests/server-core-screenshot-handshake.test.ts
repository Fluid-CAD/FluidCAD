import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'http';
import { WebSocket } from 'ws';
import { createServerCore } from '../src/server-core.ts';
import type { ServerCore } from '../src/server-core.ts';

// "Rendered" is not "on screen": a page can spend seconds applying a scene.
// A screenshot asked for right after a render used to be sent to every page
// at once, with its timeout already running — so it timed out while the page
// was still busy, or a page showing the PREVIOUS scene answered first. Now
// the capture waits for a page to report the latest scene applied, and only
// that page is asked.

let server: http.Server;
let core: ServerCore;
let wsUrl: string;
let pages: Page[];

type Page = { ws: WebSocket; received: any[]; send(msg: unknown): void };

const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));
const SCENE = { type: 'scene-rendered', result: [], absPath: '/ws/a.part.js', sceneKind: 'part', rollbackStop: -1 } as any;
const PNG = Buffer.from('png-bytes');

async function connect(options: { sceneAcks?: boolean } = {}): Promise<Page> {
  const ws = new WebSocket(wsUrl);
  const page: Page = { ws, received: [], send: (msg) => ws.send(JSON.stringify(msg)) };
  pages.push(page);
  ws.on('message', (raw) => { page.received.push(JSON.parse(String(raw))); });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  if (options.sceneAcks) {
    page.send({ type: 'ui-hello', sceneAcks: true });
  }
  await tick();
  return page;
}

const screenshotRequests = (page: Page) => page.received.filter((m) => m.type === 'take-screenshot');
const latestSceneVersion = (page: Page): number =>
  page.received.filter((m) => m.type === 'scene-rendered').at(-1).sceneVersion;

function answer(page: Page): void {
  const request = screenshotRequests(page).at(-1);
  page.send({ type: 'screenshot-result', requestId: request.requestId, success: true, data: PNG.toString('base64') });
}

describe('screenshot ⇄ scene-applied handshake', () => {
  beforeEach(async () => {
    pages = [];
    server = http.createServer();
    core = createServerCore(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    wsUrl = `ws://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  });

  afterEach(async () => {
    for (const page of pages) {
      page.ws.close();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('stamps every scene with a growing version, replayed to late pages', async () => {
    const early = await connect({ sceneAcks: true });
    core.broadcastToUI(SCENE);
    core.broadcastToUI(SCENE);
    await tick();
    expect(early.received.filter((m) => m.type === 'scene-rendered').map((m) => m.sceneVersion)).toEqual([1, 2]);
    const late = await connect({ sceneAcks: true });
    expect(latestSceneVersion(late)).toBe(2);
  });

  it('holds the capture until a page reports the latest scene applied', async () => {
    const page = await connect({ sceneAcks: true });
    core.broadcastToUI(SCENE);
    await tick();
    expect(core.isLatestSceneApplied()).toBe(false);

    const shot = core.requestScreenshot({});
    await tick();
    expect(screenshotRequests(page)).toHaveLength(0);

    page.send({ type: 'scene-applied', version: latestSceneVersion(page) });
    await tick();
    expect(core.isLatestSceneApplied()).toBe(true);
    expect(screenshotRequests(page)).toHaveLength(1);
    answer(page);
    expect(await shot).toEqual(PNG);
  });

  it('a newer render arriving meanwhile moves the goalposts', async () => {
    const page = await connect({ sceneAcks: true });
    core.broadcastToUI(SCENE);
    await tick();
    const shot = core.requestScreenshot({});
    core.broadcastToUI(SCENE);
    await tick();
    page.send({ type: 'scene-applied', version: 1 });
    await tick();
    expect(screenshotRequests(page)).toHaveLength(0);
    page.send({ type: 'scene-applied', version: 2 });
    await tick();
    expect(screenshotRequests(page)).toHaveLength(1);
    answer(page);
    await shot;
  });

  it('asks only the page showing the latest scene — a stale tab cannot answer', async () => {
    const stale = await connect({ sceneAcks: true });
    const fresh = await connect({ sceneAcks: true });
    core.broadcastToUI(SCENE);
    await tick();
    fresh.send({ type: 'scene-applied', version: latestSceneVersion(fresh) });
    await tick();

    const shot = core.requestScreenshot({});
    await tick();
    expect(screenshotRequests(fresh)).toHaveLength(1);
    expect(screenshotRequests(stale)).toHaveLength(0);
    answer(fresh);
    await shot;
  });

  it('captures at once when nothing has rendered yet', async () => {
    const page = await connect({ sceneAcks: true });
    const shot = core.requestScreenshot({});
    await tick();
    expect(screenshotRequests(page)).toHaveLength(1);
    answer(page);
    await shot;
  });

  it('falls back to asking every page when none acknowledges scenes', async () => {
    const a = await connect();
    const b = await connect();
    core.broadcastToUI(SCENE);
    const shot = core.requestScreenshot({});
    await tick();
    expect(screenshotRequests(a)).toHaveLength(1);
    expect(screenshotRequests(b)).toHaveLength(1);
    answer(b);
    expect(await shot).toEqual(PNG);
  });

  it('stops waiting when the last page leaves', async () => {
    const page = await connect({ sceneAcks: true });
    core.broadcastToUI(SCENE);
    await tick();
    const shot = core.requestScreenshot({});
    page.ws.close();
    await expect(shot).rejects.toThrow('No UI client connected.');
  });

  it('tells a caller whether the latest render became visible', async () => {
    // Nobody to show it to: the answer is immediate.
    core.broadcastToUI(SCENE);
    expect(await core.awaitLatestSceneApplied(5_000)).toBe(false);

    const page = await connect({ sceneAcks: true });
    const visible = core.awaitLatestSceneApplied(5_000);
    page.send({ type: 'scene-applied', version: latestSceneVersion(page) });
    expect(await visible).toBe(true);

    // A page that never gets there is a bounded wait, not a hang.
    core.broadcastToUI(SCENE);
    expect(await core.awaitLatestSceneApplied(60)).toBe(false);
  });

  it('rejects with no page connected', async () => {
    await expect(core.requestScreenshot({})).rejects.toThrow('No UI client connected.');
  });
});
