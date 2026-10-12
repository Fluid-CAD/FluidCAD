import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { HubClient } from '../../src/hub/hub-client.ts';
import { HubConfig } from '../../src/hub/hub-config.ts';
import { HubCredentials } from '../../src/hub/hub-credentials.ts';
import { HubLogout } from '../../src/hub/hub-logout.ts';
import { HubTransport } from '../../src/hub/hub-transport.ts';
import { FakeHub } from '../fixtures/fake-hub.ts';

/**
 * `HubLogout` (H11 follow-up 3), what `fluidcad logout` and the Hub panel's
 * Sign out both run, against `FakeHub`: revoke the saved token, then forget
 * it, whatever the hub says. FLUIDCAD_HOME is a temp directory.
 */

const OTHER_HUB = 'https://hub.fluidcad.io';

let hub: FakeHub;
let home: string;
let savedHome: string | undefined;

function logout(origin: string = hub.origin, env: NodeJS.ProcessEnv = {}) {
  const config = HubConfig.resolve({ hub: origin, env: {} });
  const transport = new HubTransport({ version: '0.0.46', client: 'app', retryDelayMs: 1 });
  return HubLogout.run({ config, client: new HubClient(config, transport), env });
}

/** A signed-in machine: a token the hub issued, saved for `origin` as `fluidcad login` saves it. */
function signIn(origin: string = hub.origin): string {
  const issued = hub.issueToken({ kind: 'cli', scopes: ['publish'] });
  HubCredentials.write(origin, { token: issued.token, tokenId: issued.id, handle: 'acme', email: 'acme@example.com' });
  return issued.token;
}

function saved(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(HubCredentials.path(), 'utf8')).hubs;
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
  savedHome = process.env.FLUIDCAD_HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-hub-logout-'));
  process.env.FLUIDCAD_HOME = home;
  HubCredentials.write(OTHER_HUB, { token: 'fch_other', tokenId: null, handle: 'acme', email: null });
});

afterEach(() => {
  if (savedHome === undefined) {
    delete process.env.FLUIDCAD_HOME;
  } else {
    process.env.FLUIDCAD_HOME = savedHome;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

describe('HubLogout', () => {
  it('revokes the saved token on the hub, then forgets it and keeps the other hubs', async () => {
    const token = signIn();
    const result = await logout();
    expect(result).toEqual({
      hub: hub.origin,
      outcome: 'revoked',
      handle: 'acme',
      email: 'acme@example.com',
      reason: null,
      unreachable: false,
      envToken: false,
    });
    expect(hub.tokenOf(token)?.revoked).toBe(true);
    const revoke = hub.requestsTo('/api/v1/me/tokens/current');
    expect(revoke).toHaveLength(1);
    expect(revoke[0].method).toBe('DELETE');
    expect(revoke[0].headers.authorization).toBe(`Bearer ${token}`);
    expect(Object.keys(saved())).toEqual([OTHER_HUB]);
  });

  it('forgets a token the hub already revoked (401) as signed out', async () => {
    const token = signIn();
    hub.tokenOf(token)!.revoked = true;
    const result = await logout();
    expect(result.outcome).toBe('already-revoked');
    expect(result.reason).toBeNull();
    expect(Object.keys(saved())).toEqual([OTHER_HUB]);
  });

  it("forgets the token when the hub can't be reached, and says the hub couldn't revoke it", async () => {
    const offline = await closedPort();
    HubCredentials.write(offline, { token: 'fch_offline', tokenId: null, handle: 'acme', email: null });
    const result = await logout(offline);
    expect(result.outcome).toBe('not-revoked');
    expect(result.unreachable).toBe(true);
    expect(result.reason).toMatch(new RegExp(`^Couldn't reach ${offline.replace(/[.:/]/g, '\\$&')}: `));
    expect(result.handle).toBe('acme');
    expect(Object.keys(saved())).toEqual([OTHER_HUB]);
  });

  it('forgets the token when the hub fails on its side (5xx), and says why', async () => {
    const token = signIn();
    hub.failNext('/api/v1/me/tokens/current', 503);
    const result = await logout();
    expect(result.outcome).toBe('not-revoked');
    expect(result.unreachable).toBe(true);
    expect(result.reason).toBe(`${hub.origin} answered with HTTP 503.`);
    expect(hub.tokenOf(token)?.revoked).toBe(false);
    expect(Object.keys(saved())).toEqual([OTHER_HUB]);
  });

  it('forgets the token when the hub refuses to revoke it (403), and says it refused', async () => {
    const token = signIn();
    hub.failNext('/api/v1/me/tokens/current', 403);
    const result = await logout();
    expect(result.outcome).toBe('not-revoked');
    expect(result.unreachable).toBe(false);
    expect(result.reason).toBe(`${hub.origin} answered with HTTP 403.`);
    expect(hub.tokenOf(token)?.revoked).toBe(false);
    expect(Object.keys(saved())).toEqual([OTHER_HUB]);
  });

  it('with nothing saved for the hub: not signed in, no request, the other hubs untouched', async () => {
    const result = await logout();
    expect(result).toEqual({
      hub: hub.origin,
      outcome: 'not-signed-in',
      handle: null,
      email: null,
      reason: null,
      unreachable: false,
      envToken: false,
    });
    expect(hub.requests).toHaveLength(0);
    expect(Object.keys(saved())).toEqual([OTHER_HUB]);
  });

  it('never revokes FLUIDCAD_HUB_TOKEN, only reports that it is set', async () => {
    const personal = hub.issueToken();
    const token = signIn();
    const result = await logout(hub.origin, { FLUIDCAD_HUB_TOKEN: personal.token });
    expect(result.outcome).toBe('revoked');
    expect(result.envToken).toBe(true);
    expect(hub.tokenOf(token)?.revoked).toBe(true);
    expect(hub.tokenOf(personal.token)?.revoked).toBe(false);

    const again = await logout(hub.origin, { FLUIDCAD_HUB_TOKEN: personal.token });
    expect(again.outcome).toBe('not-signed-in');
    expect(again.envToken).toBe(true);
    expect(hub.tokenOf(personal.token)?.revoked).toBe(false);
  });
});
