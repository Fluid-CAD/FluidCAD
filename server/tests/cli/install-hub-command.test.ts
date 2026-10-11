import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { spawn } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { TreeHash } from '../../src/packages/tree-hash.ts';
import { ArchiveFixture } from '../packages/archive-fixture.ts';
import { FakeHub } from '../fixtures/fake-hub.ts';

/**
 * `fluidcad install` from the hub (hub-plan Stage H8), run as the user runs
 * it: the real `bin/fluidcad.js` in a child process (spawned, not
 * `spawnSync`, since the in-process `FakeHub` must keep answering), over
 * archives built in memory. FLUIDCAD_PACKAGES, FLUIDCAD_HOME and the
 * preferences' HOME are temp folders. The CLI imports the compiled server
 * out of `server/dist`, so these need `npm run build:server` after a
 * server change; the rules are covered against the sources in
 * `server/tests/hub/hub-installer.test.ts`.
 */

const REPO = path.resolve(import.meta.dirname, '../../..');
const CLI = path.join(REPO, 'bin', 'fluidcad.js');
const COMPILED = path.join(REPO, 'server', 'dist', 'hub', 'hub-installer.js');
const PROXY_KEYS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy'];
const KIT = '@acme/kit';

type Run = { status: number | null; stdout: string; stderr: string };

let hub: FakeHub;
let tmp: string;
let project: string;
let outside: string;
let library: string;

function cli(cwd: string, args: string[], extraEnv: Record<string, string> = {}): Promise<Run> {
  const home = path.join(tmp, 'home');
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [...PROXY_KEYS, 'FLUIDCAD_HUB_TOKEN']) {
    delete env[key];
  }
  Object.assign(env, {
    FLUIDCAD_PACKAGES: library,
    FLUIDCAD_HOME: path.join(tmp, 'fluidcad-home'),
    FLUIDCAD_HUB_URL: hub.origin,
    HOME: home,
    XDG_CONFIG_HOME: home,
    APPDATA: home,
    ...extraEnv,
  });
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
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

/** A package on the hub, built like the packer builds it; each version's feature module differs. */
async function publish(name: string, version: string, row: Parameters<FakeHub['addArchive']>[1] = {}, manifest: Record<string, unknown> = {}) {
  return hub.addArchive(await kitArchive(name, version, manifest), row, name);
}

/** The archive {@link publish} uploads: each version's feature module differs. */
async function kitArchive(name: string, version: string, manifest: Record<string, unknown> = {}): Promise<Buffer> {
  const files = { ...ArchiveFixture.defaultFiles(), 'standoff.feature.js': `export const standoff = () => '${name}@${version}';\n` };
  return Buffer.from(await ArchiveFixture.zip({ name, version, files, manifest }));
}

/** `name@version` put in the library from a file, as a user without the hub would. */
async function installFromFile(name: string, version: string): Promise<void> {
  const file = path.join(tmp, `${name.replace(/[@/]/g, '-')}-${version}.fluidpkg`);
  fs.writeFileSync(file, await kitArchive(name, version));
  const run = await cli(outside, ['install', file, '--as', name, '-y']);
  expect(run.status).toBe(0);
}

/** A local port nothing listens on: an offline hub. */
async function closedPort(): Promise<string> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const offline = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return offline;
}

function config(): Record<string, any> {
  return JSON.parse(fs.readFileSync(path.join(project, 'fluidcad.json'), 'utf8'));
}

function pin(name: string, version: string, integrity: string): void {
  const current = config();
  current.dependencies = { ...current.dependencies, [name]: { version, integrity } };
  fs.writeFileSync(path.join(project, 'fluidcad.json'), JSON.stringify(current, null, 2) + '\n');
}

const installed = (name: string, version: string) => path.join(library, ...name.split('/'), version);

function scratchLeft(): boolean {
  return fs.existsSync(path.join(library, '.tmp'));
}

function writable(dir: string): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      writable(child);
    } else if (entry.isFile()) {
      fs.chmodSync(child, 0o644);
    }
  }
}

beforeAll(async () => {
  expect(fs.existsSync(COMPILED), 'server/dist is not built: run `npm run build:server`').toBe(true);
  hub = await FakeHub.start();
});

afterAll(async () => {
  await hub.stop();
});

beforeEach(() => {
  hub.reset();
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-cli-hub-install-')));
  project = path.join(tmp, 'project');
  outside = path.join(tmp, 'outside');
  library = path.join(tmp, 'library');
  fs.mkdirSync(project);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(project, 'fluidcad.json'), JSON.stringify({ engine: ArchiveFixture.ENGINE, unit: 'mm' }, null, 2) + '\n');
});

afterEach(() => {
  writable(tmp);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('fluidcad install <@scope/name> from the hub', () => {
  it('downloads the latest into a fresh library, verified, after the consent summary, and pins it in the project', async () => {
    await publish(KIT, '0.1.0');
    const latest = await publish(KIT, '0.2.0');

    const run = await cli(project, ['install', KIT, '--yes']);
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`Downloading @acme/kit 0.2.0 (${latest.size} B) from ${hub.origin}…`);
    expect(run.stdout).toContain(`Verified: its files hash to ${latest.integrity}, as ${hub.origin} says.`);
    expect(run.stdout).toContain('kit 0.2.0 — A test kit\n  installs as @acme/kit\n');
    expect(run.stdout).toContain("A package's code runs in the FluidCAD engine with your permissions.");
    expect(run.stdout).toContain(`Installed @acme/kit 0.2.0 into your library (${installed(KIT, '0.2.0')}).`);
    expect(run.stdout).toContain("Pinned @acme/kit 0.2.0 in this project's fluidcad.json.");
    expect(config().dependencies[KIT]).toEqual({ version: '0.2.0', integrity: latest.integrity });
    expect(await TreeHash.ofDirectory(installed(KIT, '0.2.0'))).toBe(latest.integrity);
    expect(hub.downloadsOf(KIT, '0.2.0')[0].headers['user-agent']).toMatch(/^fluidcad\/\S+ \(\S+; \S+; cli\)$/);
    expect(scratchLeft()).toBe(false);

    // Installed now: the library answers, and the hub isn't asked again.
    hub.requests.length = 0;
    const again = await cli(project, ['install', KIT]);
    expect(again.status).toBe(0);
    expect(again.stdout).toContain('This project already pins @acme/kit 0.2.0.');
    expect(hub.requests).toHaveLength(0);
  });

  it('installs name@version outside a project into the library, without a pin, and knows it is there next time', async () => {
    const first = await publish(KIT, '0.1.0');
    await publish(KIT, '0.2.0');
    const run = await cli(outside, ['install', `${KIT}@0.1.0`, '-y']);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`Installed @acme/kit 0.1.0 into your library (${installed(KIT, '0.1.0')}).`);
    expect(run.stdout).not.toContain('Pinned');
    expect(await TreeHash.ofDirectory(installed(KIT, '0.1.0'))).toBe(first.integrity);
    expect(fs.existsSync(installed(KIT, '0.2.0'))).toBe(false);
    expect(fs.existsSync(path.join(outside, 'fluidcad.json'))).toBe(false);
  });

  it('installs into the project copy with --project, and refuses without a terminal or --yes, leaving nothing', async () => {
    await publish(KIT, '0.1.0');
    const refused = await cli(project, ['install', KIT]);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('Pass --yes to install without being asked.');
    expect(refused.stderr).toContain('Nothing was installed.');
    expect(fs.existsSync(installed(KIT, '0.1.0'))).toBe(false);
    expect(config().dependencies).toBeUndefined();
    expect(scratchLeft()).toBe(false);

    const copied = await cli(project, ['install', KIT, '--project', '-y']);
    expect(copied.status).toBe(0);
    expect(copied.stdout).toContain(`Installed @acme/kit 0.1.0 into this project's packages folder (${path.join(project, 'packages', '@acme', 'kit', '0.1.0')}).`);
    expect(fs.existsSync(path.join(project, 'packages', '.tmp'))).toBe(false);
  });

  it('a yanked exact version installs with its note; a removed one refuses with the reason', async () => {
    await publish(KIT, '0.1.0', { yanked: { at: '2026-10-10T00:00:00.000Z', reason: 'wrong thread pitch' } });
    await publish(KIT, '0.2.0', { removed: { at: '2026-10-10T00:00:00.000Z', reason: 'malware' } });
    await publish(KIT, '0.3.0');

    const yanked = await cli(outside, ['install', `${KIT}@0.1.0`, '-y']);
    expect(yanked.status).toBe(0);
    expect(yanked.stdout).toContain('! @acme/kit@0.1.0 was yanked (wrong thread pitch): it installs because you asked for this version');

    const removed = await cli(outside, ['install', `${KIT}@0.2.0`, '-y']);
    expect(removed.status).toBe(1);
    expect(removed.stderr).toContain(`@acme/kit@0.2.0 was removed from ${hub.origin} by its admins (malware), and can't be installed.`);
    expect(fs.existsSync(installed(KIT, '0.2.0'))).toBe(false);
  });

  it('installs an unpublished version by exact version only with the owner\'s token', async () => {
    await publish(KIT, '0.1.0', { status: 'in_review', publishedAt: null });
    const anonymous = await cli(outside, ['install', `${KIT}@0.1.0`, '-y']);
    expect(anonymous.status).toBe(1);
    expect(anonymous.stderr).toContain(`@acme/kit@0.1.0 isn't on ${hub.origin}.`);
    expect(anonymous.stderr).toContain('sign in with `fluidcad login` first');

    const token = hub.issueToken({ kind: 'cli', scopes: ['publish'] }).token;
    const mine = await cli(outside, ['install', `${KIT}@0.1.0`, '-y'], { FLUIDCAD_HUB_TOKEN: token });
    expect(mine.status).toBe(0);
    expect(mine.stdout).toContain("! @acme/kit@0.1.0 isn't published: it is in review, and you can install it as its owner.");
    expect(hub.downloadsOf(KIT, '0.1.0').at(-1)!.headers.authorization).toBe(`Bearer ${token}`);
  });

  it('takes --hub over FLUIDCAD_HUB_URL', async () => {
    await publish(KIT, '0.1.0');
    const offline = await closedPort();

    const run = await cli(outside, ['install', KIT, '-y', '--hub', hub.origin], { FLUIDCAD_HUB_URL: offline });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`from ${hub.origin}`);
  });
});

describe('fluidcad install <@scope/name> asks the hub first', () => {
  it('downloads the hub\'s latest and pins it when the library holds an older version', async () => {
    await publish(KIT, '0.1.0');
    const latest = await publish(KIT, '0.2.0');
    await installFromFile(KIT, '0.1.0');

    const run = await cli(project, ['install', KIT, '-y']);
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`Downloading @acme/kit 0.2.0 (${latest.size} B) from ${hub.origin}…`);
    expect(run.stdout).toContain("Pinned @acme/kit 0.2.0 in this project's fluidcad.json.");
    expect(config().dependencies[KIT]).toEqual({ version: '0.2.0', integrity: latest.integrity });
    expect(hub.downloadsOf(KIT, '0.2.0')).toHaveLength(1);
  });

  it('uses the library\'s copy of the latest without a download when it has the hub\'s contents', async () => {
    await publish(KIT, '0.1.0');
    const latest = await publish(KIT, '0.2.0');
    await installFromFile(KIT, '0.2.0');

    const pinned = await cli(project, ['install', KIT]);
    expect(pinned.stderr).toBe('');
    expect(pinned.status).toBe(0);
    expect(pinned.stdout).toBe("Pinned @acme/kit 0.2.0 in this project's fluidcad.json (it loads from your library).\n");
    expect(config().dependencies[KIT]).toEqual({ version: '0.2.0', integrity: latest.integrity });

    const outsideRun = await cli(outside, ['install', KIT]);
    expect(outsideRun.status).toBe(0);
    expect(outsideRun.stdout).toContain(`@acme/kit 0.2.0 is already in your library (${installed(KIT, '0.2.0')}), with the hub's contents: nothing changed.`);
    expect(hub.downloads).toHaveLength(0);
  });

  it('takes the newest compatible version when the latest needs a newer FluidCAD, with the note', async () => {
    const older = await publish(KIT, '0.1.0');
    await publish(KIT, '0.2.0', {}, { minEngine: '0.0.99' });

    const run = await cli(project, ['install', KIT, '-y']);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`Downloading @acme/kit 0.1.0 (${older.size} B) from ${hub.origin}…`);
    expect(run.stdout).toContain(`! The latest @acme/kit, 0.2.0, needs FluidCAD 0.0.99 or newer; this FluidCAD is ${ArchiveFixture.ENGINE}, so this installs 0.1.0, the newest version it runs.`);
    expect(config().dependencies[KIT].version).toBe('0.1.0');
  });

  it('with the hub offline, pins the library\'s newest version with a note, and fails when the library has none', async () => {
    await installFromFile(KIT, '0.1.0');
    await installFromFile(KIT, '0.3.0');
    const offline = await closedPort();

    const run = await cli(project, ['install', KIT], { FLUIDCAD_HUB_URL: offline });
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(
      `Couldn't reach ${offline}, so this uses @acme/kit 0.3.0 from your library, the newest version there; the hub may have a newer one.\n` +
        "Pinned @acme/kit 0.3.0 in this project's fluidcad.json (it loads from your library).\n",
    );
    expect(config().dependencies[KIT].version).toBe('0.3.0');

    const missing = await cli(project, ['install', '@acme/gears'], { FLUIDCAD_HUB_URL: offline });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain(`Couldn't reach ${offline}: ECONNREFUSED.`);
    expect(config().dependencies['@acme/gears']).toBeUndefined();
  });

  it('refuses a package the hub doesn\'t know even with a library copy, naming the exact install, which then works offline', async () => {
    await installFromFile(KIT, '0.1.0');

    const refused = await cli(project, ['install', KIT, '-y']);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain(`@acme/kit isn't on ${hub.origin}.`);
    expect(refused.stderr).toContain('Your library has a local copy, @acme/kit 0.1.0: `fluidcad install @acme/kit@0.1.0` installs it by its exact version, without the hub.');
    expect(config().dependencies).toBeUndefined();

    const exact = await cli(project, ['install', `${KIT}@0.1.0`], { FLUIDCAD_HUB_URL: await closedPort() });
    expect(exact.status).toBe(0);
    expect(exact.stdout).toBe("Pinned @acme/kit 0.1.0 in this project's fluidcad.json (it loads from your library).\n");
  });

  it('an exact version in the library is still used without asking the hub, even when the hub has a newer one', async () => {
    await publish(KIT, '0.1.0');
    await publish(KIT, '0.2.0');
    await installFromFile(KIT, '0.1.0');
    hub.requests.length = 0;

    const run = await cli(project, ['install', `${KIT}@0.1.0`]);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("Pinned @acme/kit 0.1.0 in this project's fluidcad.json (it loads from your library).");
    expect(hub.requests).toHaveLength(0);
  });
});

describe('fluidcad install (no arguments) from the hub', () => {
  it('downloads every missing pin, each against its pin, with one consent summary', async () => {
    const kit = await publish(KIT, '0.1.0');
    await publish(KIT, '0.2.0');
    const gears = await publish('@acme/gears', '1.2.0');
    pin(KIT, '0.1.0', kit.integrity!);
    pin('@acme/gears', '1.2.0', gears.integrity!);

    const run = await cli(project, ['install', '-y']);
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`This project pins 2 packages that aren't installed; downloading from ${hub.origin}.`);
    expect(run.stdout).toContain('gears 1.2.0 — A test kit\n  installs as @acme/gears\n');
    expect(run.stdout).toContain('kit 0.1.0 — A test kit\n  installs as @acme/kit\n');
    expect(run.stdout.match(/A package's code runs in the FluidCAD engine/g)).toHaveLength(2);
    expect(run.stdout).toContain(`Installed @acme/gears 1.2.0 into your library (${installed('@acme/gears', '1.2.0')}).`);
    expect(run.stdout).toContain(`Installed @acme/kit 0.1.0 into your library (${installed(KIT, '0.1.0')}).`);
    expect(fs.existsSync(installed(KIT, '0.2.0'))).toBe(false);
    expect(config().dependencies[KIT]).toEqual({ version: '0.1.0', integrity: kit.integrity });

    const complete = await cli(project, ['install']);
    expect(complete.stdout).toContain('Every package this project pins is installed (2).');
  });

  it('asks once without --yes, and exits 1 with a line per failure while the rest install', async () => {
    const kit = await publish(KIT, '0.1.0');
    pin(KIT, '0.1.0', kit.integrity!);
    const otherBytes = `sha256-${Buffer.alloc(32, 7).toString('base64')}`;
    pin('@acme/gears', '1.2.0', `sha256-${Buffer.alloc(32, 9).toString('base64')}`);
    await publish('@acme/bolts', '2.0.0');
    pin('@acme/bolts', '2.0.0', otherBytes);

    const declined = await cli(project, ['install']);
    expect(declined.status).toBe(1);
    expect(declined.stderr).toContain('Pass --yes to install without being asked.');
    expect(fs.existsSync(installed(KIT, '0.1.0'))).toBe(false);
    expect(scratchLeft()).toBe(false);

    const run = await cli(project, ['install', '--yes']);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain(`Installed @acme/kit 0.1.0 into your library (${installed(KIT, '0.1.0')}).`);
    expect(run.stderr).toContain("Couldn't install 2 packages:");
    expect(run.stderr).toContain('  @acme/bolts 2.0.0: ');
    expect(run.stderr).toContain(`but this project pins it as ${otherBytes}`);
    expect(run.stderr).toContain(`  @acme/gears 1.2.0: @acme/gears@1.2.0 isn't on ${hub.origin}.`);
    expect(hub.downloadsOf('@acme/bolts', '2.0.0')).toHaveLength(0);
    expect(scratchLeft()).toBe(false);
  });
});
