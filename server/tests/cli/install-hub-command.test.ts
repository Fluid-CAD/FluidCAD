import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { spawn } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { PackageRoots } from '../../src/packages/package-roots.ts';
import { TreeHash } from '../../src/packages/tree-hash.ts';
import { ArchiveFixture } from '../packages/archive-fixture.ts';
import { LibrarySeed } from '../packages/library-seed.ts';
import { FakeHub } from '../fixtures/fake-hub.ts';

/**
 * `fluidcad install` from the hub (hub-plan Stage H8), run as the user runs
 * it: the real `bin/fluidcad.js` in a child process (spawned, not
 * `spawnSync`, since the in-process `FakeHub` must keep answering), over
 * archives built in memory. FLUIDCAD_PACKAGES, FLUIDCAD_HOME and the
 * preferences' HOME are temp folders. A library a test starts with is
 * seeded in-process (`LibrarySeed`): packages install only from the hub
 * (HD31), so there is no file install to seed it with. The CLI imports the compiled server
 * out of `server/dist`, so these need `npm run build:server` after a
 * server change; the rules are covered against the sources in
 * `server/tests/hub/hub-installer.test.ts`.
 */

const REPO = path.resolve(import.meta.dirname, '../../..');
const CLI = path.join(REPO, 'bin', 'fluidcad.js');
const COMPILED = path.join(REPO, 'server', 'dist', 'hub', 'hub-installer.js');
const PROXY_KEYS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy'];
const KIT = '@acme/kit';
/** The line each install prints, for `@acme/kit`'s one feature. */
const KIT_LINE = (head: string, pin = '') => `✓ ${head} · 1 feature${pin ? ` · ${pin}` : ''}\n`;

type Run = { status: number | null; stdout: string; stderr: string };

let hub: FakeHub;
let tmp: string;
let project: string;
let outside: string;
let library: string;
let savedPackages: string | undefined;

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
  return hub.addArchive(await kitArchive(name, version, manifest), row);
}

/** The archive {@link publish} uploads: each version's feature module differs. */
async function kitArchive(name: string, version: string, manifest: Record<string, unknown> = {}): Promise<Buffer> {
  const files = { ...ArchiveFixture.defaultFiles(), 'standoff.feature.js': `export const standoff = () => '${name}@${version}';\n` };
  return Buffer.from(await ArchiveFixture.zip({ name, version, files, manifest }));
}

/** `name@version` already in the library, with the bytes {@link publish} uploads: what an earlier hub install left. */
async function seedLibrary(name: string, version: string): Promise<void> {
  await LibrarySeed.install(await kitArchive(name, version));
}

/** A part or assembly entry of a manifest's `parts` list. */
function model(exportName: string, kind: 'part' | 'assembly') {
  return { exportName, module: 'index.js', name: exportName, kind, exportKind: 'value', params: [] };
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
  savedPackages = process.env.FLUIDCAD_PACKAGES;
  process.env.FLUIDCAD_PACKAGES = library;
  PackageRoots.forget();
});

afterEach(() => {
  if (savedPackages === undefined) {
    delete process.env.FLUIDCAD_PACKAGES;
  } else {
    process.env.FLUIDCAD_PACKAGES = savedPackages;
  }
  PackageRoots.forget();
  writable(tmp);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('fluidcad install <@scope/name> from the hub', () => {
  it('downloads the latest into a fresh library, verified, without asking, and pins it in the project, on one line', async () => {
    await publish(KIT, '0.1.0');
    const latest = await publish(KIT, '0.2.0');

    // No terminal and no --yes: nothing asks, and no progress line is drawn.
    const run = await cli(project, ['install', KIT]);
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(KIT_LINE('Installed @acme/kit@0.2.0 into your library', 'pinned in fluidcad.json'));
    expect(config().dependencies[KIT]).toEqual({ version: '0.2.0', integrity: latest.integrity });
    expect(await TreeHash.ofDirectory(installed(KIT, '0.2.0'))).toBe(latest.integrity);
    expect(hub.downloadsOf(KIT, '0.2.0')[0].headers['user-agent']).toMatch(/^fluidcad\/\S+ \(\S+; \S+; cli\)$/);
    expect(scratchLeft()).toBe(false);

    // Installed now: the library answers, and the hub isn't asked again.
    hub.requests.length = 0;
    const again = await cli(project, ['install', KIT]);
    expect(again.status).toBe(0);
    expect(again.stdout).toBe(KIT_LINE('Using @acme/kit@0.2.0 from your library', 'already pinned in fluidcad.json'));
    expect(hub.requests).toHaveLength(0);
  });

  it('installs name@version outside a project into the library, without a pin, and knows it is there next time', async () => {
    const first = await publish(KIT, '0.1.0');
    await publish(KIT, '0.2.0');
    const run = await cli(outside, ['install', `${KIT}@0.1.0`, '-y']);
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(KIT_LINE('Installed @acme/kit@0.1.0 into your library'));
    expect(await TreeHash.ofDirectory(installed(KIT, '0.1.0'))).toBe(first.integrity);
    expect(fs.existsSync(installed(KIT, '0.2.0'))).toBe(false);
    expect(fs.existsSync(path.join(outside, 'fluidcad.json'))).toBe(false);
  });

  it('installs into the project copy with --project, still taking --yes and -y, which do nothing', async () => {
    await publish(KIT, '0.1.0');
    const copied = await cli(project, ['install', KIT, '--project', '--yes']);
    expect(copied.stderr).toBe('');
    expect(copied.status).toBe(0);
    expect(copied.stdout).toBe(KIT_LINE("Installed @acme/kit@0.1.0 into this project's packages folder", 'pinned in fluidcad.json'));
    expect(fs.existsSync(path.join(project, 'packages', '@acme', 'kit', '0.1.0'))).toBe(true);
    expect(fs.existsSync(path.join(project, 'packages', '.tmp'))).toBe(false);
    expect(fs.existsSync(installed(KIT, '0.1.0'))).toBe(false);

    const again = await cli(project, ['install', KIT, '--project', '-y']);
    expect(again.status).toBe(0);
    expect(again.stdout).toBe(KIT_LINE("@acme/kit@0.1.0 is already in this project's packages folder", 'already pinned in fluidcad.json'));
  });

  it('counts the features, parts and assemblies, in the plural when there are several, leaving a zero out', async () => {
    const parts = [model('plate', 'part'), model('riser', 'part'), model('stack', 'assembly')];
    await publish('@acme/bench', '0.1.0', {}, {
      features: [
        { id: 'standoff', exportName: 'standoff', module: 'standoff.feature.js', meta: { label: 'Standoff' } },
        { id: 'boss', exportName: 'boss', module: 'standoff.feature.js', meta: { label: 'Boss' } },
      ],
      parts,
    });
    await publish('@acme/models', '0.1.0', {}, { features: [], parts: [model('plate', 'part'), model('stack', 'assembly'), model('rack', 'assembly')] });

    const bench = await cli(outside, ['install', '@acme/bench']);
    expect(bench.status).toBe(0);
    expect(bench.stdout).toBe('✓ Installed @acme/bench@0.1.0 into your library · 2 features, 2 parts, 1 assembly\n');
    const models = await cli(outside, ['install', '@acme/models']);
    expect(models.stdout).toBe('✓ Installed @acme/models@0.1.0 into your library · 1 part, 2 assemblies\n');
  });

  it('keeps --yes out of the help', async () => {
    const help = await cli(outside, ['install', '--help']);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('--project');
    expect(help.stdout).not.toContain('--yes');
    expect(help.stdout).not.toContain('-y,');
  });

  it('says on one short line when the version it installs needs a newer FluidCAD', async () => {
    await publish(KIT, '0.1.0', {}, { minEngine: '0.0.99' });
    const run = await cli(outside, ['install', `${KIT}@0.1.0`]);
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(
      KIT_LINE('Installed @acme/kit@0.1.0 into your library') +
        `  ! Needs FluidCAD 0.0.99 or newer; this is ${ArchiveFixture.ENGINE}, so it won't load until you upgrade.\n`,
    );
  });

  it('a yanked exact version installs with its note; a removed one refuses with the reason', async () => {
    await publish(KIT, '0.1.0', { yanked: { at: '2026-10-10T00:00:00.000Z', reason: 'wrong thread pitch' } });
    await publish(KIT, '0.2.0', { removed: { at: '2026-10-10T00:00:00.000Z', reason: 'malware' } });
    await publish(KIT, '0.3.0');

    const yanked = await cli(outside, ['install', `${KIT}@0.1.0`]);
    expect(yanked.status).toBe(0);
    expect(yanked.stdout).toBe(KIT_LINE('Installed @acme/kit@0.1.0 into your library') + '  ! Yanked (wrong thread pitch): installed because you asked for this version.\n');

    const removed = await cli(outside, ['install', `${KIT}@0.2.0`]);
    expect(removed.status).toBe(1);
    expect(removed.stdout).toBe('');
    expect(removed.stderr).toContain(`@acme/kit@0.2.0 was removed from ${hub.origin} by its admins (malware), and can't be installed.`);
    expect(fs.existsSync(installed(KIT, '0.2.0'))).toBe(false);
  });

  it('prints the deprecation message beside the package it installs (H12)', async () => {
    await publish(KIT, '0.1.0');
    hub.packages.get(KIT)!.deprecatedMessage = 'Use @acme/other instead.';
    const run = await cli(outside, ['install', KIT]);
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(KIT_LINE('Installed @acme/kit@0.1.0 into your library') + '  ! Deprecated: Use @acme/other instead.\n');
    // Already in the library: the library copy is used, and the message is still said.
    const again = await cli(outside, ['install', KIT]);
    expect(again.stdout).toBe(KIT_LINE('@acme/kit@0.1.0 is already in your library') + '  ! Deprecated: Use @acme/other instead.\n');
  });

  it('installs an unpublished version by exact version only with the owner\'s token', async () => {
    await publish(KIT, '0.1.0', { status: 'in_review', publishedAt: null });
    const anonymous = await cli(outside, ['install', `${KIT}@0.1.0`]);
    expect(anonymous.status).toBe(1);
    expect(anonymous.stderr).toContain(`@acme/kit@0.1.0 isn't on ${hub.origin}.`);
    expect(anonymous.stderr).toContain('sign in with `fluidcad login` first');

    const token = hub.issueToken({ kind: 'cli', scopes: ['publish'] }).token;
    const mine = await cli(outside, ['install', `${KIT}@0.1.0`], { FLUIDCAD_HUB_TOKEN: token });
    expect(mine.status).toBe(0);
    expect(mine.stdout).toBe(KIT_LINE('Installed @acme/kit@0.1.0 into your library') + '  ! Not published (in review): installed as its owner.\n');
    expect(hub.downloadsOf(KIT, '0.1.0').at(-1)!.headers.authorization).toBe(`Bearer ${token}`);
  });

  it('takes --hub over FLUIDCAD_HUB_URL', async () => {
    await publish(KIT, '0.1.0');
    const offline = await closedPort();

    const run = await cli(outside, ['install', KIT, '--hub', hub.origin], { FLUIDCAD_HUB_URL: offline });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(KIT_LINE('Installed @acme/kit@0.1.0 into your library'));
    expect(hub.downloadsOf(KIT, '0.1.0')).toHaveLength(1);
  });
});

describe('fluidcad install <@scope/name> asks the hub first', () => {
  it('downloads the hub\'s latest and pins it when the library holds an older version', async () => {
    await publish(KIT, '0.1.0');
    const latest = await publish(KIT, '0.2.0');
    await seedLibrary(KIT, '0.1.0');

    const run = await cli(project, ['install', KIT]);
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(KIT_LINE('Installed @acme/kit@0.2.0 into your library', 'pinned in fluidcad.json'));
    expect(config().dependencies[KIT]).toEqual({ version: '0.2.0', integrity: latest.integrity });
    expect(hub.downloadsOf(KIT, '0.2.0')).toHaveLength(1);
  });

  it('uses the library\'s copy of the latest without a download when it has the hub\'s contents', async () => {
    await publish(KIT, '0.1.0');
    const latest = await publish(KIT, '0.2.0');
    await seedLibrary(KIT, '0.2.0');

    const pinned = await cli(project, ['install', KIT]);
    expect(pinned.stderr).toBe('');
    expect(pinned.status).toBe(0);
    expect(pinned.stdout).toBe(KIT_LINE('Using @acme/kit@0.2.0 from your library', 'pinned in fluidcad.json'));
    expect(config().dependencies[KIT]).toEqual({ version: '0.2.0', integrity: latest.integrity });

    const outsideRun = await cli(outside, ['install', KIT]);
    expect(outsideRun.status).toBe(0);
    expect(outsideRun.stdout).toBe(KIT_LINE('@acme/kit@0.2.0 is already in your library'));
    expect(hub.downloads).toHaveLength(0);
  });

  it('takes the newest compatible version when the latest needs a newer FluidCAD, with the note', async () => {
    const older = await publish(KIT, '0.1.0');
    await publish(KIT, '0.2.0', {}, { minEngine: '0.0.99' });

    const run = await cli(project, ['install', KIT]);
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(KIT_LINE('Installed @acme/kit@0.1.0 into your library', 'pinned in fluidcad.json') + '  ! The latest, 0.2.0, needs FluidCAD 0.0.99 or newer.\n');
    expect(config().dependencies[KIT]).toEqual({ version: '0.1.0', integrity: older.integrity });
  });

  it('with the hub offline, pins the library\'s newest version with a note, and fails when the library has none', async () => {
    await seedLibrary(KIT, '0.1.0');
    await seedLibrary(KIT, '0.3.0');
    const offline = await closedPort();

    const run = await cli(project, ['install', KIT], { FLUIDCAD_HUB_URL: offline });
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(
      KIT_LINE('Using @acme/kit@0.3.0 from your library', 'pinned in fluidcad.json') +
        `  ! Couldn't reach ${offline}: this is the newest version in your library; the hub may have a newer one.\n`,
    );
    expect(config().dependencies[KIT].version).toBe('0.3.0');

    const missing = await cli(project, ['install', '@acme/gears'], { FLUIDCAD_HUB_URL: offline });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain(`Couldn't reach ${offline}: ECONNREFUSED.`);
    expect(config().dependencies['@acme/gears']).toBeUndefined();
  });

  it('refuses a package the hub doesn\'t know even with a library copy, naming the exact install, which then works offline', async () => {
    await seedLibrary(KIT, '0.1.0');

    const refused = await cli(project, ['install', KIT]);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain(`@acme/kit isn't on ${hub.origin}.`);
    expect(refused.stderr).toContain('Your library has a local copy, @acme/kit 0.1.0: `fluidcad install @acme/kit@0.1.0` installs it by its exact version, without the hub.');
    expect(config().dependencies).toBeUndefined();

    const exact = await cli(project, ['install', `${KIT}@0.1.0`], { FLUIDCAD_HUB_URL: await closedPort() });
    expect(exact.status).toBe(0);
    expect(exact.stdout).toBe(KIT_LINE('Using @acme/kit@0.1.0 from your library', 'pinned in fluidcad.json'));
  });

  it('an exact version in the library is still used without asking the hub, even when the hub has a newer one', async () => {
    await publish(KIT, '0.1.0');
    await publish(KIT, '0.2.0');
    await seedLibrary(KIT, '0.1.0');
    hub.requests.length = 0;

    const run = await cli(project, ['install', `${KIT}@0.1.0`]);
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(KIT_LINE('Using @acme/kit@0.1.0 from your library', 'pinned in fluidcad.json'));
    expect(hub.requests).toHaveLength(0);
  });
});

describe('fluidcad install (no arguments) from the hub', () => {
  it('downloads every missing pin, each against its pin, without asking, a line per package', async () => {
    const kit = await publish(KIT, '0.1.0');
    await publish(KIT, '0.2.0');
    const gears = await publish('@acme/gears', '1.2.0');
    pin(KIT, '0.1.0', kit.integrity!);
    pin('@acme/gears', '1.2.0', gears.integrity!);

    const run = await cli(project, ['install']);
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    const lines = run.stdout.trimEnd().split('\n');
    expect(lines[0]).toBe(`This project pins 2 packages that aren't installed; downloading from ${hub.origin}.`);
    expect(lines.slice(1).sort()).toEqual([
      '✓ Installed @acme/gears@1.2.0 into your library · 1 feature',
      '✓ Installed @acme/kit@0.1.0 into your library · 1 feature',
    ]);
    expect(await TreeHash.ofDirectory(installed('@acme/gears', '1.2.0'))).toBe(gears.integrity);
    expect(fs.existsSync(installed(KIT, '0.2.0'))).toBe(false);
    expect(config().dependencies[KIT]).toEqual({ version: '0.1.0', integrity: kit.integrity });

    const complete = await cli(project, ['install']);
    expect(complete.stdout).toContain('Every package this project pins is installed (2).');
  });

  it('exits 1 with a line per failure while the rest install, without asking; --yes changes nothing', async () => {
    const kit = await publish(KIT, '0.1.0');
    pin(KIT, '0.1.0', kit.integrity!);
    const otherBytes = `sha256-${Buffer.alloc(32, 7).toString('base64')}`;
    pin('@acme/gears', '1.2.0', `sha256-${Buffer.alloc(32, 9).toString('base64')}`);
    await publish('@acme/bolts', '2.0.0');
    pin('@acme/bolts', '2.0.0', otherBytes);

    const run = await cli(project, ['install']);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('✓ Installed @acme/kit@0.1.0 into your library · 1 feature\n');
    expect(fs.existsSync(installed(KIT, '0.1.0'))).toBe(true);
    expect(run.stderr).toContain("Couldn't install 2 packages:");
    expect(run.stderr).toContain('  @acme/bolts 2.0.0: ');
    expect(run.stderr).toContain(`but this project pins it as ${otherBytes}`);
    expect(run.stderr).toContain(`  @acme/gears 1.2.0: @acme/gears@1.2.0 isn't on ${hub.origin}.`);
    expect(hub.downloadsOf('@acme/bolts', '2.0.0')).toHaveLength(0);
    expect(scratchLeft()).toBe(false);

    // Again with --yes: the kit is installed now, and the two still fail the same way.
    const again = await cli(project, ['install', '--yes']);
    expect(again.status).toBe(1);
    expect(again.stdout).toBe(`This project pins 2 packages that aren't installed; downloading from ${hub.origin}.\n`);
    expect(again.stderr).toContain("Couldn't install 2 packages:");
    expect(again.stderr).toContain(`  @acme/gears 1.2.0: @acme/gears@1.2.0 isn't on ${hub.origin}.`);
  });

  it('says a refused saved token once, under the first package', async () => {
    const kit = await publish(KIT, '0.1.0');
    const gears = await publish('@acme/gears', '1.2.0');
    pin(KIT, '0.1.0', kit.integrity!);
    pin('@acme/gears', '1.2.0', gears.integrity!);
    const issued = hub.issueToken({ kind: 'cli', scopes: ['publish'] });
    hub.tokenOf(issued.token)!.revoked = true;

    const run = await cli(project, ['install'], { FLUIDCAD_HUB_TOKEN: issued.token });
    expect(run.status).toBe(0);
    const said = run.stdout.split('\n').filter((line) => line.includes('refused your saved token'));
    expect(said).toEqual([`  ! ${hub.origin} refused your saved token, so this ran signed out: run \`fluidcad login\` to sign in again.`]);
  });
});
