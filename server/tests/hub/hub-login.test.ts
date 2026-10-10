import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { HubConfig } from '../../src/hub/hub-config.ts';
import { HubCredentials } from '../../src/hub/hub-credentials.ts';
import { HubLogin, HubLoginError } from '../../src/hub/hub-login.ts';
import { FakeHub } from '../fixtures/fake-hub.ts';

/**
 * `HubLogin` against `FakeHub` (HD7), driven by a fake browser that GETs
 * the authorize URL and follows every redirect by hand: to the loopback
 * callback, then to the hub's `/cli/done`. FLUIDCAD_HOME is a temp
 * directory.
 */

type Visit = { chain: string[]; finalStatus: number; finalBody: string };

/** A browser that follows redirects one at a time and keeps the chain. */
class FakeBrowser {
  readonly visits: Promise<Visit>[] = [];

  /** The `openBrowser` HubLogin is given. */
  readonly open = (url: string): void => {
    this.visits.push(FakeBrowser.visit(url));
  };

  static async visit(url: string, limit = 5): Promise<Visit> {
    const chain = [url];
    let current = url;
    for (let hop = 0; hop < limit; hop++) {
      const response = await fetch(current, { redirect: 'manual' });
      const location = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && location) {
        await response.body?.cancel();
        current = new URL(location, current).toString();
        chain.push(current);
        continue;
      }
      return { chain, finalStatus: response.status, finalBody: await response.text() };
    }
    throw new Error(`more than ${limit} redirects from ${url}`);
  }
}

let hub: FakeHub;
let home: string;
let savedHome: string | undefined;
let savedToken: string | undefined;
let lines: string[];

function login(browser: FakeBrowser | ((url: string) => void), options: { timeoutMs?: number } = {}) {
  return HubLogin.run({
    config: HubConfig.resolve({ hub: hub.origin, env: {} }),
    openBrowser: browser instanceof FakeBrowser ? browser.open : browser,
    print: (line) => lines.push(line),
    version: '0.0.46',
    ...options,
  });
}

function callbackOf(chain: string[]): URL {
  return new URL(chain.find((url) => url.includes('/callback?'))!);
}

beforeAll(async () => {
  hub = await FakeHub.start();
});

afterAll(async () => {
  await hub.stop();
});

beforeEach(() => {
  savedHome = process.env.FLUIDCAD_HOME;
  savedToken = process.env.FLUIDCAD_HUB_TOKEN;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-hub-login-'));
  process.env.FLUIDCAD_HOME = home;
  delete process.env.FLUIDCAD_HUB_TOKEN;
  hub.mode = 'approve';
  hub.exchangeDelayMs = 0;
  hub.doneVisits.length = 0;
  hub.requests.length = 0;
  lines = [];
});

afterEach(() => {
  if (savedHome === undefined) {
    delete process.env.FLUIDCAD_HOME;
  } else {
    process.env.FLUIDCAD_HOME = savedHome;
  }
  if (savedToken !== undefined) {
    process.env.FLUIDCAD_HUB_TOKEN = savedToken;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

describe('HubLogin', () => {
  it('signs in: exchanges the code, writes the credentials, then sends the browser to /cli/done?request=…', async () => {
    const browser = new FakeBrowser();
    const result = await login(browser);
    const visit = await browser.visits[0];

    // The authorize URL: the hub contract's parameters, a 127.0.0.1 loopback, S256.
    const authorize = new URL(visit.chain[0]);
    expect(`${authorize.origin}${authorize.pathname}`).toBe(`${hub.origin}/cli/authorize`);
    expect(authorize.searchParams.get('response_type')).toBe('code');
    expect(authorize.searchParams.get('client_id')).toBe('fluidcad-cli');
    expect(authorize.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(authorize.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(authorize.searchParams.get('client_version')).toBe('0.0.46');
    expect(authorize.searchParams.get('arch')).toBe(process.arch);
    expect(lines).toContain(`  ${visit.chain[0]}`);

    // The browser lands on the done page with the request id and no status flag.
    const request = callbackOf(visit.chain).searchParams.get('request')!;
    expect(visit.chain.at(-1)).toBe(`${hub.origin}/cli/done?request=${request}`);
    expect(visit.finalStatus).toBe(200);
    expect(hub.doneVisits).toEqual([request]);

    // The exchange happened before the redirect: the request was collected.
    expect(hub.authorizations.get(request)?.collected).toBe(true);
    const exchange = JSON.parse(hub.requestsTo('/api/v1/cli/token').at(-1)!.body);
    expect(exchange.redirectUri).toBe(authorize.searchParams.get('redirect_uri'));

    expect(result).toMatchObject({ origin: hub.origin, handle: 'acme', email: 'acme@example.com', path: path.join(home, 'credentials.json') });
    const stored = HubCredentials.stored(hub.origin)!;
    expect(stored.token).toMatch(/^fch_[0-9A-Za-z]{43}$/);
    expect(stored).toEqual({ token: stored.token, tokenId: result.tokenId, handle: 'acme', email: 'acme@example.com' });
    expect(hub.tokenOf(stored.token)?.kind).toBe('cli');
  });

  it('writes the credentials before the browser is redirected', async () => {
    let browsing: Promise<unknown> = Promise.resolve();
    const browser = (url: string) => {
      browsing = (async () => {
        const toCallback = await fetch(url, { redirect: 'manual' });
        const toDone = await fetch(toCallback.headers.get('location')!, { redirect: 'manual' });
        // The redirect's headers have arrived: the file is already there.
        return { status: toDone.status, location: toDone.headers.get('location'), stored: HubCredentials.stored(hub.origin) };
      })();
    };
    await login(browser);
    const atRedirect = (await browsing) as { status: number; location: string; stored: unknown };
    expect(atRedirect.status).toBe(302);
    expect(atRedirect.location).toContain('/cli/done?request=');
    expect(atRedirect.stored).toMatchObject({ handle: 'acme' });
  });

  it('denied: writes nothing, and the browser still lands on the done page', async () => {
    hub.mode = 'deny';
    const browser = new FakeBrowser();
    const err = await login(browser).catch((e) => e);
    const visit = await browser.visits[0];

    expect(err).toBeInstanceOf(HubLoginError);
    expect(err.code).toBe('denied');
    expect(err.message).toBe('Sign-in was denied in the browser. Nothing was saved.');
    expect(callbackOf(visit.chain).searchParams.get('error')).toBe('access_denied');
    expect(visit.chain.at(-1)).toMatch(new RegExp(`^${hub.origin}/cli/done\\?request=[A-Za-z0-9_-]+$`));
    expect(hub.requestsTo('/api/v1/cli/token')).toHaveLength(0);
    expect(fs.existsSync(HubCredentials.path())).toBe(false);
  });

  it('state mismatch: refused, nothing exchanged or written, and the browser is not sent to the hub', async () => {
    hub.mode = 'tamper-state';
    const browser = new FakeBrowser();
    const err = await login(browser).catch((e) => e);
    const visit = await browser.visits[0];

    expect(err).toBeInstanceOf(HubLoginError);
    expect(err.code).toBe('state-mismatch');
    expect(visit.finalStatus).toBe(400);
    expect(visit.chain.at(-1)).toContain('/callback?');
    expect(hub.requestsTo('/api/v1/cli/token')).toHaveLength(0);
    expect(hub.doneVisits).toEqual([]);
    expect(fs.existsSync(HubCredentials.path())).toBe(false);
  });

  it('exchange failure: nothing is written, and the browser still lands on the done page', async () => {
    for (const mode of ['expire', 'fail'] as const) {
      hub.mode = mode;
      hub.doneVisits.length = 0;
      const browser = new FakeBrowser();
      const err = await login(browser).catch((e) => e);
      const visit = await browser.visits[0];

      expect(err).toBeInstanceOf(HubLoginError);
      expect(err.code).toBe('exchange-failed');
      expect(err.message).toBe(
        mode === 'expire'
          ? "The hub didn't give this machine a token: This sign-in request expired. Run `fluidcad login` again. Nothing was saved."
          : "The hub didn't give this machine a token: Something went wrong on the hub. Nothing was saved.",
      );
      const request = callbackOf(visit.chain).searchParams.get('request');
      expect(visit.chain.at(-1)).toBe(`${hub.origin}/cli/done?request=${request}`);
      expect(hub.doneVisits).toEqual([request]);
      expect(fs.existsSync(HubCredentials.path())).toBe(false);
    }
  });

  it('times out when the browser never comes back, and stops listening', async () => {
    let authorizeUrl = '';
    const started = Date.now();
    const err = await login((url) => {
      authorizeUrl = url;
    }, { timeoutMs: 150 }).catch((e) => e);

    expect(err).toBeInstanceOf(HubLoginError);
    expect(err.code).toBe('timeout');
    expect(err.message).toBe('No answer from the browser within 1 s. Run `fluidcad login` again.');
    expect(Date.now() - started).toBeLessThan(2000);
    const callback = new URL(authorizeUrl).searchParams.get('redirect_uri')!;
    await expect(fetch(`${callback}?code=x&state=y`)).rejects.toThrow();
    expect(fs.existsSync(HubCredentials.path())).toBe(false);
  });

  it('says five minutes by default', () => {
    expect(HubLogin.TIMEOUT_MS).toBe(5 * 60 * 1000);
  });

  it('refuses a second callback', async () => {
    hub.exchangeDelayMs = 200;
    let second: Promise<Response> | null = null;
    const browser = async (url: string) => {
      const toCallback = await fetch(url, { redirect: 'manual' });
      const callback = toCallback.headers.get('location')!;
      const first = fetch(callback, { redirect: 'manual' });
      // The first callback is still exchanging when the second arrives.
      await new Promise((resolve) => setTimeout(resolve, 50));
      second = fetch(callback, { redirect: 'manual' });
      await first;
    };
    const result = await login(browser);
    const refused = await second!;

    expect(result.handle).toBe('acme');
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain('already finished');
    expect(hub.requestsTo('/api/v1/cli/token')).toHaveLength(1);
  });

  it('answers 404 for anything but GET /callback', async () => {
    let authorizeUrl = '';
    const pending = login((url) => {
      authorizeUrl = url;
    }, { timeoutMs: 2000 }).catch((e) => e);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const callback = new URL(new URL(authorizeUrl).searchParams.get('redirect_uri')!);
    const other = await fetch(`${callback.origin}/favicon.ico`);
    expect(other.status).toBe(404);
    // The login is still waiting for its callback.
    const finished = await FakeBrowser.visit(authorizeUrl);
    expect(finished.chain.at(-1)).toContain('/cli/done?request=');
    expect(await pending).toMatchObject({ handle: 'acme' });
  });
});
