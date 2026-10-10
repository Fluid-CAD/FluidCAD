import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { EnvHttpProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { HubClient } from '../../src/hub/hub-client.ts';
import { HubConfig } from '../../src/hub/hub-config.ts';
import { HubRequestError } from '../../src/hub/hub-request-error.ts';
import { HubTransport } from '../../src/hub/hub-transport.ts';
import { FakeHub } from '../fixtures/fake-hub.ts';

/**
 * The GH #80 lessons, ported (hub-plan Stage H3): a time limit on every
 * request, the user agent, the proxy agent, one retry for idempotent GETs,
 * and the hub's errors as `HubRequestError`. Everything runs against
 * `FakeHub` or a local server; nothing leaves the machine.
 */

let hub: FakeHub;

function client(token: string | null = null, options: { timeoutMs?: number } = {}): HubClient {
  const config = HubConfig.resolve({ hub: hub.origin, env: {} });
  return new HubClient(config, new HubTransport({ version: '9.9.9', retryDelayMs: 1, ...options }), token);
}

beforeAll(async () => {
  hub = await FakeHub.start();
});

afterAll(async () => {
  await hub.stop();
});

afterEach(() => {
  hub.requests.length = 0;
});

describe('HubTransport', () => {
  it('names the client in the user agent', async () => {
    expect(HubTransport.userAgent('0.0.46', 'cli', 'darwin', 'arm64')).toBe('fluidcad/0.0.46 (darwin; arm64; cli)');
    expect(HubTransport.userAgent('0.0.46', 'app', 'win32', 'x64')).toBe('fluidcad/0.0.46 (win32; x64; app)');

    await client().meta();
    expect(hub.requestsTo('/api/v1')[0].headers['user-agent']).toBe(`fluidcad/9.9.9 (${process.platform}; ${process.arch}; cli)`);
  });

  it('retries an idempotent GET once on a 502, 503 or 504', async () => {
    for (const status of [502, 503, 504]) {
      hub.requests.length = 0;
      hub.failNext('/api/v1', status);
      const meta = await client().meta();
      expect(meta.name).toBe('FluidCAD Hub');
      expect(hub.requestsTo('/api/v1')).toHaveLength(2);
    }
  });

  it('retries only once, then answers the error', async () => {
    hub.failNext('/api/v1', 503, 2);
    const err = await client().meta().catch((e) => e);
    expect(err).toBeInstanceOf(HubRequestError);
    expect(err.status).toBe(503);
    expect(err.code).toBe('unexpected-response');
    expect(hub.requestsTo('/api/v1')).toHaveLength(2);
  });

  it('does not retry a 500, or any write', async () => {
    hub.failNext('/api/v1', 500);
    await expect(client().meta()).rejects.toMatchObject({ status: 500 });
    expect(hub.requestsTo('/api/v1')).toHaveLength(1);

    hub.failNext('/api/v1/cli/token', 503);
    await expect(client().exchangeCliCode({ clientId: 'fluidcad-cli', code: 'x', codeVerifier: 'v'.repeat(43), redirectUri: 'http://127.0.0.1:1/callback' })).rejects.toMatchObject({ status: 503 });
    expect(hub.requestsTo('/api/v1/cli/token')).toHaveLength(1);

    hub.failNext('/api/v1/me/tokens/current', 502);
    const token = hub.issueToken();
    await expect(client(token.token).revokeCurrentToken()).rejects.toMatchObject({ status: 502 });
    expect(hub.requestsTo('/api/v1/me/tokens/current')).toHaveLength(1);
  });

  it('retries a GET once after a network error, then reports it as unreachable', async () => {
    // A port nothing listens on: bind one, then close it.
    const probe = http.createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()));
    const { port } = probe.address() as AddressInfo;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const config = HubConfig.resolve({ hub: `http://127.0.0.1:${port}`, env: {} });
    const err = await new HubClient(config, new HubTransport({ version: '1.0.0', retryDelayMs: 1 })).meta().catch((e) => e);
    expect(err).toBeInstanceOf(HubRequestError);
    expect(err.status).toBe(0);
    expect(err.code).toBe('network');
    expect(err.unreachable).toBe(true);
    expect(err.message).toBe(`Couldn't reach http://127.0.0.1:${port}: ECONNREFUSED.`);
  });

  it('gives up on a hub that never answers, after its time limit', async () => {
    const silent = http.createServer(() => {
      // Never answers.
    });
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', () => resolve()));
    const { port } = silent.address() as AddressInfo;
    try {
      const config = HubConfig.resolve({ hub: `http://127.0.0.1:${port}`, env: {} });
      const started = Date.now();
      const err = await new HubClient(config, new HubTransport({ version: '1.0.0', timeoutMs: 150, retryDelayMs: 1 })).meta().catch((e) => e);
      expect(err).toBeInstanceOf(HubRequestError);
      expect(err.code).toBe('timeout');
      expect(err.message).toBe(`http://127.0.0.1:${port} didn't answer within 150 ms.`);
      // A timeout is not retried.
      expect(Date.now() - started).toBeLessThan(1500);
    } finally {
      silent.closeAllConnections();
      await new Promise<void>((resolve) => silent.close(() => resolve()));
    }
  });
});

describe('HubTransport.followProxyEnvironment', () => {
  let previous: ReturnType<typeof getGlobalDispatcher>;

  beforeAll(() => {
    previous = getGlobalDispatcher();
  });

  afterEach(() => {
    setGlobalDispatcher(previous);
  });

  it('installs the proxy agent when HTTPS_PROXY or HTTP_PROXY is set', () => {
    const agent = HubTransport.followProxyEnvironment({ HTTPS_PROXY: 'http://127.0.0.1:9' });
    expect(agent).toBeInstanceOf(EnvHttpProxyAgent);
    expect(getGlobalDispatcher()).toBe(agent);

    setGlobalDispatcher(previous);
    expect(HubTransport.followProxyEnvironment({ http_proxy: 'http://127.0.0.1:9' })).toBeInstanceOf(EnvHttpProxyAgent);
  });

  it('installs nothing without a proxy, or with NO_PROXY=*', () => {
    expect(HubTransport.followProxyEnvironment({})).toBeNull();
    expect(HubTransport.followProxyEnvironment({ HTTPS_PROXY: 'http://127.0.0.1:9', NO_PROXY: '*' })).toBeNull();
    expect(getGlobalDispatcher()).toBe(previous);
  });

  it("sends a hub request through the proxy, and keeps loopback off it", async () => {
    const seen: string[] = [];
    const proxy = http.createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ name: 'FluidCAD Hub', apiVersion: 'v1', openapi: '/api/v1/openapi.json', limits: {} }));
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', () => resolve()));
    const { port } = proxy.address() as AddressInfo;
    try {
      HubTransport.followProxyEnvironment({ HTTP_PROXY: `http://127.0.0.1:${port}` });

      const remote = HubConfig.resolve({ hub: 'http://hub.example.test', env: {} });
      const meta = await new HubClient(remote, new HubTransport({ version: '1.0.0' })).meta();
      expect(meta.name).toBe('FluidCAD Hub');
      expect(seen).toEqual(['GET http://hub.example.test/api/v1']);

      // The local FakeHub is loopback: straight there, never through the proxy.
      await client().meta();
      expect(seen).toHaveLength(1);
      expect(hub.requestsTo('/api/v1')).toHaveLength(1);
    } finally {
      proxy.closeAllConnections();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });
});

describe('HubClient', () => {
  it('reads /me with the bearer token, and words a refused token with the hub code', async () => {
    const token = hub.issueToken({ kind: 'cli', scopes: ['publish'] });
    const me = await client(token.token).me();
    expect(me.account.handle).toBe('acme');
    expect(me.via).toBe('token');
    expect(me.token).toEqual({ id: token.id, kind: 'cli', scopes: ['publish'], suffix: token.token.slice(-4) });
    expect(hub.requestsTo('/api/v1/me')[0].headers.authorization).toBe(`Bearer ${token.token}`);

    const err = await client('fch_unknown').me().catch((e) => e);
    expect(err).toBeInstanceOf(HubRequestError);
    expect(err.status).toBe(401);
    expect(err.code).toBe('unauthorized');
    expect(err.unauthorized).toBe(true);
    expect(err.message).toBe('This API token is not valid. Sign in again with `fluidcad login`.');
  });

  it('revokes the current token: 204, then 401', async () => {
    const token = hub.issueToken();
    await client(token.token).revokeCurrentToken();
    expect(hub.tokenOf(token.token)?.revoked).toBe(true);
    await expect(client(token.token).revokeCurrentToken()).rejects.toMatchObject({ status: 401, code: 'unauthorized' });
    await expect(client(token.token).me()).rejects.toMatchObject({ status: 401 });
  });

  it('refuses to ask for /me without a token', async () => {
    await expect(client().me()).rejects.toThrow('HubClient.me() needs a token.');
  });

  it('sends the exchange in camelCase and words invalid-grant', async () => {
    const err = await client().exchangeCliCode({ clientId: 'fluidcad-cli', code: 'nope', codeVerifier: 'v'.repeat(43), redirectUri: 'http://127.0.0.1:1/callback' }).catch((e) => e);
    expect(err).toMatchObject({ status: 400, code: 'invalid-grant', message: 'This code is not valid.' });
    expect(JSON.parse(hub.requestsTo('/api/v1/cli/token')[0].body)).toEqual({
      clientId: 'fluidcad-cli',
      code: 'nope',
      codeVerifier: 'v'.repeat(43),
      redirectUri: 'http://127.0.0.1:1/callback',
    });
    expect(hub.requestsTo('/api/v1/cli/token')[0].headers['content-type']).toBe('application/json');
  });
});
