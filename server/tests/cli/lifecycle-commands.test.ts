import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ArchiveFixture } from '../packages/archive-fixture.ts';
import { FakeHub } from '../fixtures/fake-hub.ts';

/**
 * `fluidcad deprecate` and `listing …` (hub-plan Stage H12), run as the
 * user runs them: the real `bin/fluidcad.js` in a child process against
 * the in-process FakeHub, signed in through `FLUIDCAD_HUB_TOKEN`.
 * FLUIDCAD_HOME and HOME are temp folders. The CLI imports the compiled
 * server out of `server/dist`: run `npm run build:server` after a server
 * change.
 */

const REPO = path.resolve(import.meta.dirname, '../../..');
const CLI = path.join(REPO, 'bin', 'fluidcad.js');
const COMPILED = path.join(REPO, 'server', 'dist', 'hub', 'hub-maintainer.js');
const PROXY_KEYS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy', 'FLUIDCAD_HUB_TOKEN'];
const PNG = Buffer.from('89504e470d0a1a0a0000000d494844520000000400000003080600000000000000', 'hex');

type Run = { status: number | null; stdout: string; stderr: string };

let hub: FakeHub;
let tmp: string;
let workspace: string;
let token: string;

function cli(args: string[], options: { cwd?: string; token?: string | null } = {}): Promise<Run> {
  const home = path.join(tmp, 'home');
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of PROXY_KEYS) {
    delete env[key];
  }
  Object.assign(env, {
    FLUIDCAD_HOME: path.join(tmp, 'fluidcad-home'),
    FLUIDCAD_PACKAGES: path.join(tmp, 'library'),
    FLUIDCAD_HUB_URL: hub.origin,
    HOME: home,
    XDG_CONFIG_HOME: home,
    APPDATA: home,
  });
  const chosen = options.token === undefined ? token : options.token;
  if (chosen) {
    env.FLUIDCAD_HUB_TOKEN = chosen;
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: options.cwd ?? workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

beforeAll(async () => {
  if (!fs.existsSync(COMPILED)) {
    throw new Error('server/dist is missing hub-maintainer.js: run `npm run build:server` first.');
  }
  hub = await FakeHub.start();
});

afterAll(async () => {
  await hub.stop();
});

beforeEach(async () => {
  hub.reset();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-cli-'));
  workspace = path.join(tmp, 'kit');
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'fluidcad.json'), JSON.stringify({ package: { name: '@acme/kit', version: '0.2.0' } }, null, 2));
  token = hub.issueToken({ kind: 'cli', scopes: ['publish'] }).token;
  for (const version of ['0.1.0', '0.2.0']) {
    await hub.addArchive(await ArchiveFixture.zip({ version }));
  }
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('fluidcad deprecate', () => {
  it('deprecates the workspace’s package with a message, names another by its name, and clears with --clear', async () => {
    const set = await cli(['deprecate', 'Use', '@acme/other', 'instead.']);
    expect(set.status).toBe(0);
    expect(set.stdout).toBe(
      `✓ Deprecated @acme/kit on ${hub.origin}: “Use @acme/other instead.”\n` +
        "  It stays installable; search, its page, FluidCAD's Hub panel and `fluidcad install` show the message.\n",
    );
    expect(hub.packages.get('@acme/kit')!.deprecatedMessage).toBe('Use @acme/other instead.');
    const named = await cli(['deprecate', '@acme/kit', 'Moved.'], { cwd: tmp });
    expect(named.stdout).toContain('“Moved.”');
    const cleared = await cli(['deprecate', '@acme/kit', '--clear'], { cwd: tmp });
    expect(cleared.stdout).toBe(`✓ @acme/kit is no longer deprecated on ${hub.origin}.\n`);
    expect(hub.packages.get('@acme/kit')!.deprecatedMessage).toBeNull();
    const nothing = await cli(['deprecate']);
    expect([nothing.status, nothing.stderr]).toEqual([1, 'Write the message (what to use instead, or why), such as `fluidcad deprecate @acme/kit "Use @acme/other instead."`, or pass --clear.\n']);
  });

  it('refuses a package under another handle before asking the hub, and signed out', async () => {
    const other = await cli(['deprecate', '@bea-tools/kit', 'Moved.']);
    expect(other.status).toBe(1);
    expect(other.stderr).toBe(`@bea-tools/kit is under @bea-tools, but you are signed in to ${hub.origin} as @acme, and only its owner can change it: sign in as @bea-tools.\n`);
    expect(hub.requests.some((request) => request.path.includes('@bea-tools'))).toBe(false);
    const signedOut = await cli(['deprecate', 'Moved.'], { token: null });
    expect(signedOut.stderr).toBe(`Not signed in to ${hub.origin}. Run \`fluidcad login\` first.\n`);
  });
});

describe('fluidcad listing', () => {
  it('sets the license and links, refuses a license the hub doesn’t offer with its list, and shows the listing', async () => {
    const refused = await cli(['listing', 'set', '--license', 'WTFPL']);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toBe(`The request is not valid: license: ${FakeHub.licenseRefusal('WTFPL')}\n`);
    const set = await cli(['listing', 'set', '--license', 'MIT', '--homepage', 'https://acme.example/kit', '--repository', '']);
    expect(set.status).toBe(0);
    expect(set.stdout).toBe("✓ Saved @acme/kit's listing:\n  license     MIT\n  homepage    https://acme.example/kit\n  repository  none\n");
    const show = await cli(['listing', 'show']);
    expect(show.stdout).toBe(
      '@acme/kit · latest 0.2.0\n  license     MIT\n  homepage    https://acme.example/kit\n  repository  none\n  deprecated  no\n  screenshots 0 (`fluidcad listing screenshots list`)\n',
    );
  });

  it('sets the notes of the version in review, and refuses with nothing open', async () => {
    const none = await cli(['listing', 'notes', 'New', 'sizes.']);
    expect(none.status).toBe(1);
    expect(none.stderr).toContain("@acme/kit has no draft or version in review on");
    hub.packages.get('@acme/kit')!.versions.push({ version: '0.3.0', status: 'in_review', notes: '' });
    const notes = await cli(['listing', 'notes', 'New', 'sizes.', '-p', '@acme/kit'], { cwd: tmp });
    expect(notes.stdout).toBe('✓ Saved the release notes of @acme/kit@0.3.0 (in review): “New sizes.”\n');
  });

  it('adds, lists, orders, picks the card and removes screenshots', async () => {
    for (const name of ['a.png', 'b.png']) {
      fs.writeFileSync(path.join(tmp, name), PNG);
    }
    fs.writeFileSync(path.join(tmp, 'c.svg'), '<svg/>');
    const added = await cli(['listing', 'screenshots', 'add', path.join(tmp, 'a.png'), path.join(tmp, 'b.png'), '--caption', 'Hub flange']);
    expect(added.stdout).toBe('✓ Added a.png as number 1, the card image.\n✓ Added b.png as number 2.\n');
    const refused = await cli(['listing', 'screenshots', 'add', path.join(tmp, 'c.svg')]);
    expect([refused.status, refused.stderr]).toEqual([1, "c.svg isn't a PNG, JPEG or WebP image: export it as one of those, then add it.\n"]);
    const list = await cli(['listing', 'screenshots', 'list']);
    expect(list.stdout).toMatch(/^ 1\. [0-9a-f-]{36} {2}a\.png · 800 × 600 · 33 B · card image · “Hub flange”\n 2\. [0-9a-f-]{36} {2}b\.png · 800 × 600 · 33 B · “Hub flange”\n$/);
    const ordered = await cli(['listing', 'screenshots', 'order', '2']);
    expect(ordered.stdout.split('\n')[1]).toContain('b.png');
    expect((await cli(['listing', 'screenshots', 'card', '1'])).stdout).toBe("✓ b.png is @acme/kit's card image: search and FluidCAD's Hub panel show it.\n");
    expect((await cli(['listing', 'screenshots', 'remove', '2'])).stdout).toBe('✓ Removed a.png from @acme/kit.\n');
    expect([...hub.media.values()].map((shot) => shot.fileName)).toEqual(['b.png']);
  });
});
