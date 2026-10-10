import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { FakeHub } from '../fixtures/fake-hub.ts';

/**
 * `fluidcad login`, `whoami` and `logout`, run as the user runs them: the
 * real `bin/fluidcad.js` in a child process, against an in-process
 * `FakeHub`. The test plays the browser: `FLUIDCAD_NO_BROWSER=1` keeps the
 * CLI from opening one, and the test GETs the printed URL and follows its
 * redirects. FLUIDCAD_HOME and FLUIDCAD_PACKAGES are temp directories. The
 * CLI imports the compiled server out of `server/dist`, so these need
 * `npm run build:server` after a server change.
 */

const REPO = path.resolve(import.meta.dirname, '../../..');
const CLI = path.join(REPO, 'bin', 'fluidcad.js');
const COMPILED = path.join(REPO, 'server', 'dist', 'hub', 'hub-login.js');
const PROXY_KEYS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy'];

type Run = { status: number | null; stdout: string; stderr: string };

let hub: FakeHub;
let home: string;
let library: string;

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [...PROXY_KEYS, 'FLUIDCAD_HUB_TOKEN']) {
    delete base[key];
  }
  return {
    ...base,
    FLUIDCAD_HOME: home,
    FLUIDCAD_PACKAGES: library,
    FLUIDCAD_HUB_URL: hub.origin,
    FLUIDCAD_NO_BROWSER: '1',
    ...extra,
  };
}

/** Runs the CLI; `onLine` sees each stdout line as it comes, so the test can act as the browser. */
function cli(args: string[], options: { input?: string; env?: Record<string, string>; onLine?: (line: string) => void } = {}): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: home, env: env(options.env), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let pending = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        options.onLine?.(line);
      }
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(options.input ?? '');
  });
}

/** Follows redirects by hand from `url`; answers every URL visited. */
async function browse(url: string): Promise<string[]> {
  const chain = [url];
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    const response = await fetch(current, { redirect: 'manual' });
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location) {
      return chain;
    }
    current = new URL(location, current).toString();
    chain.push(current);
  }
  return chain;
}

/** `fluidcad login`, approving in the "browser" as soon as the URL is printed. */
async function loginInBrowser(args: string[] = []): Promise<{ run: Run; chain: string[] }> {
  let visit: Promise<string[]> | null = null;
  const run = await cli(['login', ...args], {
    onLine: (line) => {
      const match = /^\s+(http:\/\/127\.0\.0\.1:\d+\/cli\/authorize\?\S+)$/.exec(line);
      if (match && !visit) {
        visit = browse(match[1]);
      }
    },
  });
  return { run, chain: visit ? await visit : [] };
}

function credentials(): Record<string, any> {
  return JSON.parse(fs.readFileSync(path.join(home, 'credentials.json'), 'utf8'));
}

beforeAll(async () => {
  expect(fs.existsSync(COMPILED), 'server/dist is not built: run `npm run build:server`').toBe(true);
  hub = await FakeHub.start();
});

afterAll(async () => {
  await hub.stop();
});

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-cli-hub-home-'));
  library = fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-cli-hub-library-'));
  hub.mode = 'approve';
  hub.requests.length = 0;
  hub.doneVisits.length = 0;
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(library, { recursive: true, force: true });
});

describe('fluidcad login', () => {
  it('signs in through the browser, saves the token for the hub, and lands the browser on /cli/done', async () => {
    const { run, chain } = await loginInBrowser();

    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`Opening your browser to sign in to ${hub.origin}…`);
    expect(run.stdout).toContain(`✓ Signed in as @acme (acme@example.com) · saved to ${path.join(home, 'credentials.json')}`);
    expect(run.stdout).toContain(`  hub: ${hub.origin}`);
    expect(chain.at(-1)).toMatch(new RegExp(`^${hub.origin}/cli/done\\?request=[A-Za-z0-9_-]+$`));

    const saved = credentials().hubs[hub.origin];
    expect(saved.token).toMatch(/^fch_[0-9A-Za-z]{43}$/);
    expect(saved).toMatchObject({ handle: 'acme', email: 'acme@example.com' });
    expect(hub.tokenOf(saved.token)?.id).toBe(saved.tokenId);
    if (process.platform !== 'win32') {
      expect(fs.statSync(path.join(home, 'credentials.json')).mode & 0o777).toBe(0o600);
    }
    // The device panel's fields came along, and the user agent says cli.
    const authorize = new URL(chain[0]);
    expect(authorize.searchParams.get('client_version')).toBe(JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version);
    expect(hub.requestsTo('/api/v1/cli/token')[0].headers['user-agent']).toMatch(/^fluidcad\/\S+ \(\w+; \w+; cli\)$/);
  });

  it('takes the hub from --hub over FLUIDCAD_HUB_URL', async () => {
    let visit: Promise<string[]> | null = null;
    const run = await cli(['login', '--hub', `${hub.origin}/`], {
      env: { FLUIDCAD_HUB_URL: 'http://127.0.0.1:9' },
      onLine: (line) => {
        const match = /^\s+(http:\S+\/cli\/authorize\?\S+)$/.exec(line);
        if (match && !visit) {
          visit = browse(match[1]);
        }
      },
    });
    await visit;
    expect(run.status).toBe(0);
    expect(Object.keys(credentials().hubs)).toEqual([hub.origin]);
  });

  it('exits 1 and saves nothing when the sign-in is denied', async () => {
    hub.mode = 'deny';
    const { run, chain } = await loginInBrowser();

    expect(run.status).toBe(1);
    expect(run.stderr).toContain('Sign-in was denied in the browser. Nothing was saved.');
    expect(chain.at(-1)).toContain('/cli/done?request=');
    expect(fs.existsSync(path.join(home, 'credentials.json'))).toBe(false);
  });

  it('refuses a hub URL with a path', async () => {
    const run = await cli(['login', '--hub', 'https://example.com/hub']);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("--hub is the hub's address alone, like https://example.com");
  });
});

describe('fluidcad login --with-token', () => {
  it('checks the token with /me, then saves it with its id, handle and email', async () => {
    const issued = hub.issueToken({ kind: 'personal', scopes: ['account', 'publish'] });
    const run = await cli(['login', '--with-token'], { input: `${issued.token}\n` });

    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`✓ Signed in as @acme (acme@example.com) · saved to ${path.join(home, 'credentials.json')}`);
    expect(credentials().hubs[hub.origin]).toEqual({ token: issued.token, tokenId: issued.id, handle: 'acme', email: 'acme@example.com' });
    expect(hub.requestsTo('/api/v1/me')[0].headers.authorization).toBe(`Bearer ${issued.token}`);
    // No browser flow.
    expect(hub.requestsTo('/cli/authorize')).toHaveLength(0);
  });

  it('refuses a token the hub does not accept, and saves nothing', async () => {
    const run = await cli(['login', '--with-token'], { input: 'fch_nottherealthing\n' });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`${hub.origin} doesn't accept that token (revoked, expired or mistyped). Nothing was saved.`);
    expect(fs.existsSync(path.join(home, 'credentials.json'))).toBe(false);
  });

  it('refuses an empty stdin', async () => {
    const run = await cli(['login', '--with-token'], { input: '\n' });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('No token on stdin.');
  });
});

describe('fluidcad whoami', () => {
  it('prints the handle, email, hub and token kind', async () => {
    await loginInBrowser();
    const token = credentials().hubs[hub.origin].token;

    const run = await cli(['whoami']);
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(
      [
        '@acme (acme@example.com)',
        `  hub:   ${hub.origin}`,
        `  token: cli token …${token.slice(-4)} (publish), from ${path.join(home, 'credentials.json')}`,
        '',
      ].join('\n'),
    );
  });

  it('exits 1 when signed out', async () => {
    const run = await cli(['whoami']);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`Not signed in to ${hub.origin}. Run \`fluidcad login\`.`);
    expect(hub.requests).toHaveLength(0);
  });

  it('uses FLUIDCAD_HUB_TOKEN over the saved token, and says so', async () => {
    await loginInBrowser();
    const personal = hub.issueToken({ kind: 'personal', scopes: ['account'] });
    const run = await cli(['whoami'], { env: { FLUIDCAD_HUB_TOKEN: personal.token } });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`  token: personal token …${personal.token.slice(-4)} (account), from FLUIDCAD_HUB_TOKEN`);
  });

  it('exits 1 when the hub no longer accepts the token', async () => {
    await loginInBrowser();
    hub.tokenOf(credentials().hubs[hub.origin].token)!.revoked = true;
    const run = await cli(['whoami']);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`${hub.origin} no longer accepts the token from ${path.join(home, 'credentials.json')} (revoked or expired).`);
  });
});

describe('fluidcad logout', () => {
  it('revokes the token on the hub, forgets it, and whoami then exits 1', async () => {
    await loginInBrowser();
    const token = credentials().hubs[hub.origin].token;

    const run = await cli(['logout']);
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`✓ Signed @acme (acme@example.com) out of ${hub.origin} · the token is revoked`);
    expect(hub.tokenOf(token)?.revoked).toBe(true);
    expect(credentials().hubs).toEqual({});

    expect((await cli(['whoami'])).status).toBe(1);
  });

  it('keeps the other hubs signed in', async () => {
    fs.writeFileSync(
      path.join(home, 'credentials.json'),
      JSON.stringify({ hubs: { 'https://hub.fluidcad.io': { token: 'fch_prod', tokenId: null, handle: 'acme', email: null } } }),
      { mode: 0o600 },
    );
    await loginInBrowser();
    await cli(['logout']);
    expect(Object.keys(credentials().hubs)).toEqual(['https://hub.fluidcad.io']);
  });

  it('forgets a token the hub already revoked (401), without failing', async () => {
    await loginInBrowser();
    hub.tokenOf(credentials().hubs[hub.origin].token)!.revoked = true;
    const run = await cli(['logout']);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('the token was already revoked');
    expect(credentials().hubs).toEqual({});
  });

  it('forgets the token but exits 1 when the hub cannot revoke it', async () => {
    await loginInBrowser();
    hub.failNext('/api/v1/me/tokens/current', 503);
    const run = await cli(['logout']);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`couldn't revoke the token: ${hub.origin} answered with HTTP 503.`);
    expect(credentials().hubs).toEqual({});
  });

  it('says so when not signed in, and never revokes FLUIDCAD_HUB_TOKEN', async () => {
    const personal = hub.issueToken();
    const run = await cli(['logout'], { env: { FLUIDCAD_HUB_TOKEN: personal.token } });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`Not signed in to ${hub.origin}.`);
    expect(run.stdout).toContain('FLUIDCAD_HUB_TOKEN is still set; unset it to stop using that token.');
    expect(hub.tokenOf(personal.token)?.revoked).toBe(false);
    expect(hub.requests).toHaveLength(0);
  });
});

describe('fluidcad publish', () => {
  it('says it is being rewritten, and exits 1 without touching the hub', async () => {
    const run = await cli(['publish', '--new-model']);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('`fluidcad publish` is being rewritten for the new FluidCAD hub');
    expect(hub.requests).toHaveLength(0);
  });
});
