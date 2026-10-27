import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import express from 'express';
import fs from 'fs';
import http from 'http';
import net from 'net';
import os from 'os';
import path from 'path';
import { createHubRouter } from '../../src/routes/hub.ts';
import { HubCredentials } from '../../src/hub/hub-credentials.ts';
import { HubTransport } from '../../src/hub/hub-transport.ts';
import { ArchiveFixture } from '../packages/archive-fixture.ts';
import { FakeHub } from '../fixtures/fake-hub.ts';

/**
 * The Hub panel's Like through the engine (H13 in the app):
 * `GET /api/hub/packages/@s/n/me` and `PUT` / `DELETE …/like` against the
 * in-process FakeHub. They act as the signed-in account, so unlike the
 * bridge's reads they never go anonymous: each refusal is mapped to a code
 * the panel words (`signed-out`, `sign-in-again`, `forbidden`,
 * `rate-limited`, `not-found`, `hub-unreachable`). The credentials live in
 * a temp FLUIDCAD_HOME; the hub URL reaches the router through its `env`.
 */

const ENGINE = ArchiveFixture.ENGINE;
const KIT = '@acme/kit';
const ENV_KEYS = ['FLUIDCAD_HOME', 'HOME', 'FLUIDCAD_HUB_TOKEN'] as const;

let hub: FakeHub;
let saved: Record<string, string | undefined>;
let tmp: string;
let servers: http.Server[];

async function serve(options: { env?: Record<string, string>; hubUrl?: string } = {}): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use('/api', createHubRouter({
    workspacePath: '',
    engineVersion: ENGINE,
    sdkVersion: 1,
    env: { FLUIDCAD_HUB_URL: options.hubUrl ?? hub.origin, ...options.env },
    transport: new HubTransport({ version: ENGINE, client: 'app', retryDelayMs: 1 }),
  }));
  const server = http.createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return `http://127.0.0.1:${(server.address() as net.AddressInfo).port}/api`;
}

async function call(url: string, init: RequestInit = {}): Promise<{ status: number; body: any; headers: Headers }> {
  const res = await fetch(url, init);
  return { status: res.status, body: await res.json(), headers: res.headers };
}

const like = (base: string, name = KIT) => call(`${base}/hub/packages/${name}/like`, { method: 'PUT' });
const unlike = (base: string, name = KIT) => call(`${base}/hub/packages/${name}/like`, { method: 'DELETE' });
const state = (base: string, name = KIT) => call(`${base}/hub/packages/${name}/me`);

/** Signed in as `fluidcad login` leaves it: the token saved for the hub's origin. */
function signIn(options: Parameters<FakeHub['issueToken']>[0] = { kind: 'cli', scopes: ['publish', 'social'] }): string {
  const token = hub.issueToken(options).token;
  HubCredentials.write(hub.origin, { token, tokenId: null, handle: 'acme', email: 'acme@example.com' });
  return token;
}

/** `@acme/kit` 1.0.0, published, with `likes` from other accounts. */
async function publishKit(likes = 4): Promise<void> {
  await hub.addArchive(await ArchiveFixture.zip({ version: '1.0.0' }));
  hub.packages.get(KIT)!.likes = likes;
}

/** A local port nothing listens on: an offline hub. */
async function closedPort(): Promise<string> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

beforeAll(async () => {
  hub = await FakeHub.start();
});

afterAll(async () => {
  await hub.stop();
});

beforeEach(() => {
  hub.reset();
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-hub-likes-')));
  process.env.FLUIDCAD_HOME = path.join(tmp, 'fluidcad-home');
  process.env.HOME = path.join(tmp, 'home');
  delete process.env.FLUIDCAD_HUB_TOKEN;
  servers = [];
});

afterEach(async () => {
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved[key];
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('PUT / DELETE /api/hub/packages/@scope/name/like and GET …/me', () => {
  it('likes and stops liking as the signed-in account, with its token, answering the count after each change', async () => {
    await publishKit(4);
    const token = signIn();
    const base = await serve();

    expect(await state(base)).toMatchObject({ status: 200, body: { package: KIT, liked: false } });
    const liked = await like(base);
    expect(liked.status).toBe(200);
    expect(liked.body).toEqual({ package: KIT, liked: true, likes: 5 });
    expect(liked.headers.get('cache-control')).toBe('no-store');
    // Idempotent, as the hub's route is: liking again changes nothing.
    expect((await like(base)).body).toEqual({ package: KIT, liked: true, likes: 5 });
    const read = await state(base);
    expect(read.body).toMatchObject({ package: KIT, liked: true });
    expect(read.headers.get('cache-control')).toBe('no-store');
    expect((await unlike(base)).body).toEqual({ package: KIT, liked: false, likes: 4 });
    expect((await unlike(base)).body).toEqual({ package: KIT, liked: false, likes: 4 });

    const writes = hub.requestsTo(`/api/v1/packages/${KIT}/like`);
    expect(writes.map((request) => request.method)).toEqual(['PUT', 'PUT', 'DELETE', 'DELETE']);
    for (const request of [...writes, ...hub.requestsTo(`/api/v1/packages/${KIT}/me`)]) {
      expect(request.headers.authorization).toBe(`Bearer ${token}`);
    }
  });

  it('signs with FLUIDCAD_HUB_TOKEN when it is set, as every engine request does', async () => {
    await publishKit();
    const token = hub.issueToken({ kind: 'personal', scopes: ['social'] }).token;
    const base = await serve({ env: { FLUIDCAD_HUB_TOKEN: token } });
    expect((await like(base)).body).toMatchObject({ liked: true, likes: 5 });
    expect(hub.requestsTo(`/api/v1/packages/${KIT}/like`)[0].headers.authorization).toBe(`Bearer ${token}`);
  });

  it('answers 401 signed-out with no credentials, asking the hub nothing', async () => {
    await publishKit();
    const base = await serve();
    for (const answer of [await like(base), await unlike(base), await state(base)]) {
      expect(answer.status).toBe(401);
      expect(answer.body).toMatchObject({ code: 'signed-out', details: { reason: 'no-credentials' } });
      expect(answer.headers.get('cache-control')).toBe('no-store');
    }
    expect(hub.requests.filter((request) => request.path.startsWith(`/api/v1/packages/${KIT}`))).toHaveLength(0);
  });

  it('answers 401 signed-out for a token the hub refuses, and never tries again anonymously', async () => {
    await publishKit();
    const token = signIn();
    hub.tokenOf(token)!.revoked = true;
    const base = await serve();
    const answer = await like(base);
    expect(answer.status).toBe(401);
    expect(answer.body).toMatchObject({ code: 'signed-out', details: { reason: 'token-refused' } });
    expect((await state(base)).body.code).toBe('signed-out');
    const sent = [...hub.requestsTo(`/api/v1/packages/${KIT}/like`), ...hub.requestsTo(`/api/v1/packages/${KIT}/me`)];
    expect(sent).toHaveLength(2);
    expect(sent.every((request) => request.headers.authorization === `Bearer ${token}`)).toBe(true);
    expect(hub.likers.get(KIT)?.size ?? 0).toBe(0);
  });

  it('answers 403 sign-in-again for a CLI sign-in older than the social scope, keeping the hub sentence', async () => {
    await publishKit();
    signIn({ kind: 'cli', scopes: ['publish'] });
    const base = await serve();
    for (const answer of [await like(base), await state(base)]) {
      expect(answer.status).toBe(403);
      expect(answer.body).toEqual({ error: FakeHub.SIGN_IN_AGAIN, code: 'sign-in-again', details: { scope: 'social', signInAgain: true } });
    }
  });

  it("passes on the hub's plain 403 for a personal token without the scope", async () => {
    await publishKit();
    signIn({ kind: 'personal', scopes: ['publish'] });
    const base = await serve();
    const answer = await like(base);
    expect(answer.status).toBe(403);
    expect(answer.body).toEqual({ error: "This API token doesn't have the `social` scope.", code: 'forbidden', details: { scope: 'social' } });
  });

  it("passes on the hub's 429 rate-limited and 404 not-found", async () => {
    await publishKit();
    signIn();
    const base = await serve();
    hub.nextLike = { status: 429, code: 'rate-limited', message: 'Too many changes this minute. Try again in a minute.' };
    expect(await like(base)).toMatchObject({ status: 429, body: { code: 'rate-limited', error: 'Too many changes this minute. Try again in a minute.' } });
    expect(hub.likers.get(KIT)?.size ?? 0).toBe(0);
    expect(await like(base, '@acme/nothing')).toMatchObject({ status: 404, body: { code: 'not-found' } });
    expect(await state(base, '@acme/nothing')).toMatchObject({ status: 404, body: { code: 'not-found' } });
  });

  it('answers 503 hub-unreachable when the hub is offline or fails on its side, without retrying a write', async () => {
    await publishKit();
    const token = signIn();
    const nowhere = await closedPort();
    HubCredentials.write(nowhere, { token, tokenId: null, handle: 'acme', email: null });
    const offline = await serve({ hubUrl: nowhere });
    expect(await like(offline)).toMatchObject({ status: 503, body: { code: 'hub-unreachable' } });
    expect(await state(offline)).toMatchObject({ status: 503, body: { code: 'hub-unreachable' } });

    const base = await serve();
    hub.failNext(`/api/v1/packages/${KIT}/like`, 503);
    expect(await like(base)).toMatchObject({ status: 503, body: { code: 'hub-unreachable' } });
    expect(hub.requestsTo(`/api/v1/packages/${KIT}/like`)).toHaveLength(1);
  });

  it('refuses a name that is not a package name (400) without asking the hub', async () => {
    signIn();
    const base = await serve();
    expect(await like(base, 'acme/kit')).toMatchObject({ status: 400, body: { code: 'bad-request' } });
    expect(await state(base, '@acme/Kit')).toMatchObject({ status: 400, body: { code: 'bad-request' } });
    expect(hub.requests.filter((request) => /\/(like|me)$/.test(request.path))).toHaveLength(0);
  });
});
