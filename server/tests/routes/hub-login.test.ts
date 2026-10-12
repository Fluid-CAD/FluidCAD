import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import express from 'express';
import fs from 'fs';
import http from 'http';
import net from 'net';
import os from 'os';
import path from 'path';
import { createHubRouter } from '../../src/routes/hub.ts';
import type { HubAppLogin, HubAppLoginState } from '../../src/hub/hub-app-login.ts';
import { HubCredentials } from '../../src/hub/hub-credentials.ts';
import { HubTransport } from '../../src/hub/hub-transport.ts';
import { FakeHub } from '../fixtures/fake-hub.ts';

/**
 * Signing in from the app (H11 follow-up 2): `POST`/`GET`/`DELETE
 * /api/hub/login` against the in-process FakeHub, whose `/cli/authorize`
 * sends the browser straight back to the loopback as an approving (or
 * denying) user would. The tests play the browser the page would open:
 * they GET the answered `authorizeUrl` and follow each redirect. The
 * credentials land in a temp FLUIDCAD_HOME, where `fluidcad login` writes
 * them.
 */

const ENGINE = '0.0.46';
const ENV_KEYS = ['FLUIDCAD_HOME', 'HOME', 'FLUIDCAD_HUB_TOKEN'] as const;

let hub: FakeHub;
let saved: Record<string, string | undefined>;
let tmp: string;
let servers: http.Server[];
let logins: HubAppLogin[];

async function serve(options: { hubUrl?: string; loginTimeoutMs?: number } = {}): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use('/api', createHubRouter({
    workspacePath: '',
    engineVersion: ENGINE,
    sdkVersion: 1,
    env: { FLUIDCAD_HUB_URL: options.hubUrl ?? hub.origin },
    transport: new HubTransport({ version: ENGINE, client: 'app', retryDelayMs: 1 }),
    loginTimeoutMs: options.loginTimeoutMs,
    onLogin: (login) => logins.push(login),
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

function start(api: string) {
  return call(`${api}/hub/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
}

/** The browser the page opens: GET the URL and follow each redirect by hand, keeping the chain. */
async function browse(url: string, limit = 5): Promise<{ chain: string[]; status: number }> {
  const chain = [url];
  let current = url;
  for (let hop = 0; hop < limit; hop++) {
    const response = await fetch(current, { redirect: 'manual' });
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (response.status >= 300 && response.status < 400 && location) {
      current = new URL(location, current).toString();
      chain.push(current);
      continue;
    }
    return { chain, status: response.status };
  }
  throw new Error(`more than ${limit} redirects from ${url}`);
}

/** `GET /api/hub/login` until the sign-in has ended, as the panel follows it. */
async function ended(api: string, deadlineMs = 3000): Promise<HubAppLoginState> {
  const until = Date.now() + deadlineMs;
  for (;;) {
    const { body } = await call(`${api}/hub/login`);
    if (body.login && body.login.status !== 'pending') {
      return body.login;
    }
    if (Date.now() > until) {
      throw new Error(`still ${JSON.stringify(body.login)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** A local port nothing listens on: an offline hub. */
async function closedPort(): Promise<string> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

function loopbackOf(authorizeUrl: string): string {
  return new URL(authorizeUrl).searchParams.get('redirect_uri')!;
}

beforeAll(async () => {
  hub = await FakeHub.start();
});

afterAll(async () => {
  await hub.stop();
});

beforeEach(() => {
  hub.reset();
  hub.exchangeDelayMs = 0;
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-hub-login-routes-')));
  process.env.FLUIDCAD_HOME = path.join(tmp, 'fluidcad-home');
  process.env.HOME = path.join(tmp, 'home');
  delete process.env.FLUIDCAD_HUB_TOKEN;
  servers = [];
  logins = [];
});

afterEach(async () => {
  for (const login of logins) {
    login.dispose();
  }
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

describe('POST /api/hub/login → the browser → GET /api/hub/login', () => {
  it("signs in through the hub's authorize page and saves the credentials where fluidcad login does", async () => {
    const api = await serve();
    expect((await call(`${api}/hub/login`)).body).toEqual({ login: null });

    const started = await start(api);
    expect(started.status).toBe(200);
    expect(started.headers.get('cache-control')).toBe('no-store');
    expect(started.body.resumed).toBe(false);
    const login = started.body.login as HubAppLoginState;
    expect(login).toMatchObject({ hub: hub.origin, status: 'pending', handle: null, code: null, error: null });
    // The CLI's authorize URL: the hub's /cli/authorize, a 127.0.0.1 loopback, PKCE S256.
    const authorize = new URL(login.authorizeUrl!);
    expect(`${authorize.origin}${authorize.pathname}`).toBe(`${hub.origin}/cli/authorize`);
    expect(authorize.searchParams.get('client_id')).toBe('fluidcad-cli');
    expect(authorize.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('client_version')).toBe(ENGINE);
    // The hub's request life: five minutes.
    const life = Date.parse(login.expiresAt) - Date.parse(login.startedAt);
    expect(life).toBeGreaterThan(5 * 60 * 1000 - 1000);
    expect(life).toBeLessThanOrEqual(5 * 60 * 1000 + 1000);
    // Waiting: the same sign-in, with the page to open again.
    expect((await call(`${api}/hub/login`)).body.login).toEqual(login);
    expect(HubCredentials.stored(hub.origin)).toBeNull();

    // The user authorizes in the browser: the loopback exchanges the code, then sends the browser to /cli/done.
    const visit = await browse(login.authorizeUrl!);
    expect(visit.chain.at(-1)).toMatch(new RegExp(`^${hub.origin}/cli/done\\?request=`));
    const done = await ended(api);
    expect(done).toMatchObject({ id: login.id, status: 'signed-in', handle: 'acme', authorizeUrl: null, code: null, error: null });

    const stored = HubCredentials.stored(hub.origin)!;
    expect(stored).toMatchObject({ handle: 'acme', email: 'acme@example.com' });
    expect(HubCredentials.path()).toBe(path.join(tmp, 'fluidcad-home', 'credentials.json'));
    expect(fs.statSync(HubCredentials.path()).mode & 0o777).toBe(0o600);
    expect(hub.tokenOf(stored.token)?.kind).toBe('cli');
    // The status the panel reads next names the handle.
    expect((await call(`${api}/hub/status`)).body.signedIn).toEqual({ handle: 'acme' });
    // The loopback is closed.
    await expect(fetch(`${loopbackOf(login.authorizeUrl!)}?code=x&state=y`)).rejects.toThrow();
  });

  it('denial: nothing saved, the sign-in says it was denied, and the browser lands on the done page', async () => {
    hub.mode = 'deny';
    const api = await serve();
    const login = (await start(api)).body.login as HubAppLoginState;
    const visit = await browse(login.authorizeUrl!);
    expect(visit.chain.at(-1)).toMatch(new RegExp(`^${hub.origin}/cli/done\\?request=`));
    expect(await ended(api)).toMatchObject({
      id: login.id,
      status: 'denied',
      handle: null,
      authorizeUrl: null,
      error: 'The sign-in was denied in the browser. Nothing was saved.',
    });
    expect(fs.existsSync(HubCredentials.path())).toBe(false);
    expect((await call(`${api}/hub/status`)).body.signedIn).toBeNull();
  });

  it("expiry: nothing came back within the hub request's life (a closed browser tab), the loopback closes", async () => {
    const api = await serve({ loginTimeoutMs: 150 });
    const login = (await start(api)).body.login as HubAppLoginState;
    expect(Date.parse(login.expiresAt) - Date.parse(login.startedAt)).toBeLessThan(1000);
    expect(await ended(api)).toMatchObject({
      id: login.id,
      status: 'expired',
      authorizeUrl: null,
      error: 'The sign-in wasn’t finished within 5 minutes, the time the hub gives it. Nothing was saved.',
    });
    await expect(fetch(`${loopbackOf(login.authorizeUrl!)}?code=x&state=y`)).rejects.toThrow();
    expect(fs.existsSync(HubCredentials.path())).toBe(false);
  });

  it('a second start while one waits answers that one: one loopback, whichever page asks, at once or later', async () => {
    const api = await serve();
    const [a, b] = await Promise.all([start(api), start(api)]);
    expect(a.body.login.id).toBe(b.body.login.id);
    expect(a.body.login.authorizeUrl).toBe(b.body.login.authorizeUrl);
    expect([a.body.resumed, b.body.resumed].sort()).toEqual([false, true]);
    const later = await start(api);
    expect(later.body).toEqual({ login: a.body.login, resumed: true });
    expect(hub.requestsTo('/api/v1')).toHaveLength(1);

    // Opening the page again (a new hub request, the same PKCE) finishes the same sign-in.
    await browse(later.body.login.authorizeUrl);
    expect(await ended(api)).toMatchObject({ id: a.body.login.id, status: 'signed-in', handle: 'acme' });
    // Once it ended, Sign in starts a new one.
    const next = await start(api);
    expect(next.body.resumed).toBe(false);
    expect(next.body.login.id).not.toBe(a.body.login.id);
    expect(next.body.login.authorizeUrl).not.toBe(a.body.login.authorizeUrl);
  });

  it('DELETE cancels the waiting sign-in: the loopback closes, nothing is saved, a new start is a new sign-in', async () => {
    const api = await serve();
    const login = (await start(api)).body.login as HubAppLoginState;
    const cancelled = await call(`${api}/hub/login`, { method: 'DELETE' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.login).toMatchObject({ id: login.id, status: 'cancelled', authorizeUrl: null, error: 'Sign-in cancelled. Nothing was saved.' });
    await expect(fetch(`${loopbackOf(login.authorizeUrl!)}?code=x&state=y`)).rejects.toThrow();
    // Cancelling again, or with nothing waiting, changes nothing.
    expect((await call(`${api}/hub/login`, { method: 'DELETE' })).body.login.status).toBe('cancelled');
    const next = (await start(api)).body;
    expect(next.resumed).toBe(false);
    expect(next.login.id).not.toBe(login.id);
    expect(fs.existsSync(HubCredentials.path())).toBe(false);
  });

  it('a cancel after the browser came back leaves the exchange to finish', async () => {
    hub.exchangeDelayMs = 200;
    const api = await serve();
    const login = (await start(api)).body.login as HubAppLoginState;
    const visiting = browse(login.authorizeUrl!);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const cancel = await call(`${api}/hub/login`, { method: 'DELETE' });
    expect(cancel.body.login.status).toBe('pending');
    await visiting;
    expect(await ended(api)).toMatchObject({ status: 'signed-in', handle: 'acme' });
    expect(HubCredentials.stored(hub.origin)).toMatchObject({ handle: 'acme' });
  });

  it("an exchange the hub refuses or can't answer fails in the app's words, nothing saved", async () => {
    for (const [mode, code, error] of [
      ['expire', 'exchange-failed', `${new URL(hub.origin).host} didn’t give FluidCAD a token: This sign-in request expired. Nothing was saved.`],
      ['fail', 'hub-unreachable', `Couldn’t reach ${new URL(hub.origin).host} to finish signing in. Nothing was saved.`],
      ['tamper-state', 'state-mismatch', 'The browser came back from a sign-in FluidCAD didn’t start, so it was refused. Nothing was saved.'],
    ] as const) {
      hub.mode = mode;
      const api = await serve();
      const login = (await start(api)).body.login as HubAppLoginState;
      await browse(login.authorizeUrl!);
      expect(await ended(api)).toMatchObject({ id: login.id, status: 'failed', code, error });
      expect(fs.existsSync(HubCredentials.path())).toBe(false);
    }
  });

  it('refuses with 503 hub-unreachable when the hub does not answer, starting nothing', async () => {
    const offline = await closedPort();
    const api = await serve({ hubUrl: offline });
    const refused = await start(api);
    expect(refused.status).toBe(503);
    expect(refused.body).toMatchObject({ code: 'hub-unreachable', details: { hub: offline, cause: 'network' } });
    expect((await call(`${api}/hub/login`)).body).toEqual({ login: null });
  });

  it('takes a JSON body only, so another site cannot start a sign-in without CORS', async () => {
    const api = await serve();
    const refused = await call(`${api}/hub/login`, { method: 'POST' });
    expect(refused.status).toBe(415);
    expect(refused.body.code).toBe('bad-request');
    expect((await call(`${api}/hub/login`)).body).toEqual({ login: null });
  });
});
