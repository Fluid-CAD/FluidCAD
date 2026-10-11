import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { ArchiveFixture } from '../packages/archive-fixture.ts';
import { LibrarySeed } from '../packages/library-seed.ts';
import { HubInstallMessages } from '../../src/hub/hub-install-error.ts';
import { PackageRoots } from '../../src/packages/package-roots.ts';

/**
 * `fluidcad install`, `remove` and `packages`, run as the user runs them:
 * the real `bin/fluidcad.js` in a child process. The CLI imports the
 * compiled server out of `server/dist`, so these need `npm run
 * build:server` after a server change; the rules are covered against the
 * sources in `server/tests/packages/package-installer.test.ts`.
 *
 * Packages install only from the hub (HD31): a file or a path is refused,
 * so a library these tests need is seeded in-process (`LibrarySeed`, the
 * hub download's own install path).
 *
 * FLUIDCAD_PACKAGES, FLUIDCAD_HOME and the preferences' HOME all point at
 * temp folders: nothing reaches the user's library or settings. The hub is
 * a local port nothing listens on (an offline hub), so what isn't in the
 * library fails clearly without any network; the hub installs are in
 * `install-hub-command.test.ts`.
 */

const REPO = path.resolve(import.meta.dirname, '../../..');
const CLI = path.join(REPO, 'bin', 'fluidcad.js');
const COMPILED = path.join(REPO, 'server', 'dist', 'packages', 'project-packages.js');

let tmp: string;
let project: string;
let outside: string;
let library: string;
let kit: string;
let offlineHub: string;
let savedPackages: string | undefined;

function cli(cwd: string, ...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const home = path.join(tmp, 'home');
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      FLUIDCAD_HUB_URL: offlineHub,
      FLUIDCAD_HUB_TOKEN: '',
      HTTPS_PROXY: '',
      HTTP_PROXY: '',
      https_proxy: '',
      http_proxy: '',
      FLUIDCAD_PACKAGES: library,
      FLUIDCAD_HOME: path.join(tmp, 'fluidcad-home'),
      HOME: home,
      XDG_CONFIG_HOME: home,
      APPDATA: home,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

async function archive(file: string, options: Parameters<typeof ArchiveFixture.zip>[0] = {}): Promise<string> {
  const abs = path.join(tmp, file);
  fs.writeFileSync(abs, await ArchiveFixture.zip(options));
  return abs;
}

function config(): Record<string, any> {
  return JSON.parse(fs.readFileSync(path.join(project, 'fluidcad.json'), 'utf8'));
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

const installedKit = () => path.join(library, '@acme', 'kit', '0.1.0');

beforeAll(async () => {
  expect(fs.existsSync(COMPILED), 'server/dist is not built: run `npm run build:server`').toBe(true);
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  offlineHub = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-cli-install-')));
  project = path.join(tmp, 'project');
  outside = path.join(tmp, 'outside');
  library = path.join(tmp, 'library');
  fs.mkdirSync(project);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(project, 'fluidcad.json'), JSON.stringify({ engine: ArchiveFixture.ENGINE, unit: 'mm' }, null, 2) + '\n');
  kit = await archive('acme-kit-0.1.0.fluidpkg');
  // The in-process seed writes into the same library the child process reads.
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

/** `@acme/kit` 0.1.0 into the library (or the project copy), pinned in the project when asked: what a hub install leaves. */
function seed(options: { target?: 'library' | 'project'; pin?: boolean } = {}) {
  return LibrarySeed.install(fs.readFileSync(kit), { target: options.target, project, pin: options.pin });
}

/** Every entry under `dir`, or none when it doesn't exist. */
function entries(dir: string): string[] {
  return fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map(String).sort() : [];
}

describe('fluidcad install <file or path> (HD31)', () => {
  it.each([
    ['a relative .fluidpkg path', () => ['./acme-kit-0.1.0.fluidpkg']],
    ['an absolute .fluidpkg path', () => [kit]],
    ['a .fluidpkg path that doesn\'t exist', () => [path.join(tmp, 'missing-0.1.0.fluidpkg')]],
    ['an existing directory', () => ['./project']],
    ['a .fluidpkg path with --project', () => [kit, '--project']],
    ['a .fluidpkg path with --yes and --library', () => [kit, '--yes', '--library']],
  ])('refuses %s with the sentence, reading nothing and touching neither root', (_label, args) => {
    const before = fs.readFileSync(path.join(project, 'fluidcad.json'), 'utf8');
    // An unreadable archive: reading it would fail with EACCES, not the sentence.
    fs.chmodSync(kit, 0o000);
    const run = cli(tmp, 'install', ...args());
    fs.chmodSync(kit, 0o644);

    expect(run.status).toBe(1);
    expect(run.stderr.trim()).toBe(HubInstallMessages.NO_FILE_INSTALLS);
    expect(run.stderr.trim()).toBe(
      'Packages install from the hub: `fluidcad install @<handle>/<name>`. A .fluidpkg file is what `fluidcad pack` makes for `fluidcad publish`; it isn\'t installed.',
    );
    expect(run.stdout).toBe('');
    expect(fs.existsSync(library)).toBe(false);
    expect(entries(path.join(project, 'packages'))).toEqual([]);
    expect(fs.readFileSync(path.join(project, 'fluidcad.json'), 'utf8')).toBe(before);
  });

  it('refuses a path from inside a project too, leaving its pins and both roots as they were', () => {
    const run = cli(project, 'install', '../acme-kit-0.1.0.fluidpkg', '--yes');
    expect(run.status).toBe(1);
    expect(run.stderr.trim()).toBe(HubInstallMessages.NO_FILE_INSTALLS);
    expect(config().dependencies).toBeUndefined();
    expect(fs.existsSync(library)).toBe(false);
    expect(fs.existsSync(path.join(project, 'packages'))).toBe(false);
  });

  it('knows no --as', () => {
    const run = cli(project, 'install', kit, '--as', '@acme/kit');
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("error: unknown option '--as'");
    expect(fs.existsSync(library)).toBe(false);
  });

  it('refuses a bare name that is no path, naming the publisher form', () => {
    const run = cli(project, 'install', 'feature-tests');
    expect(run.status).toBe(1);
    expect(run.stderr.trim()).toBe('Name the publisher: `fluidcad install @<handle>/feature-tests`.');
  });

  it('refuses both targets at once', () => {
    expect(cli(project, 'install', '@acme/kit', '--library', '--project').stderr).toContain('Pass --library or --project, not both.');
  });
});

describe('fluidcad install <@scope/name>', () => {
  it('pins a library package into the project, and with --project copies it in', async () => {
    await seed();

    // An exact version takes the library's copy without asking the hub.
    const pinned = cli(project, 'install', '@acme/kit@0.1.0');
    expect(pinned.stderr).toBe('');
    expect(pinned.status).toBe(0);
    expect(pinned.stdout).toBe('Pinned @acme/kit 0.1.0 in this project\'s fluidcad.json (it loads from your library).\n');
    expect(fs.existsSync(path.join(project, 'packages'))).toBe(false);

    const copied = cli(project, 'install', '@acme/kit@0.1.0', '--project');
    expect(copied.status).toBe(0);
    expect(copied.stdout).toContain("Installed @acme/kit 0.1.0 into this project's packages folder");
    expect(copied.stdout).toContain('This project already pins @acme/kit 0.1.0.');
  });

  it('with the hub offline, a name alone pins the library\'s newest version with a note, and says clearly why the rest fails', async () => {
    await seed();
    const pinned = cli(project, 'install', '@acme/kit');
    expect(pinned.status).toBe(0);
    expect(pinned.stdout).toContain(`Couldn't reach ${offlineHub}, so this uses @acme/kit 0.1.0 from your library, the newest version there; the hub may have a newer one.`);
    expect(pinned.stdout).toContain('Pinned @acme/kit 0.1.0');

    const missing = cli(project, 'install', '@acme/gears');
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain(`Couldn't reach ${offlineHub}: ECONNREFUSED.`);
    expect(missing.stderr).toContain(HubInstallMessages.OFFLINE_HINT);
    expect(missing.stderr).not.toContain('.fluidpkg');
    expect(config().dependencies['@acme/gears']).toBeUndefined();

    const already = cli(outside, 'install', '@acme/kit@0.1.0');
    expect(already.status).toBe(0);
    expect(already.stdout).toContain(`@acme/kit 0.1.0 is already in your library (${installedKit()}).`);
  });
});

describe('fluidcad install (no arguments)', () => {
  it('exits 0 when every pin is installed, and 1 listing the ones in neither root', async () => {
    expect(cli(project, 'install').stdout).toContain('This project pins no packages.');
    await seed({ pin: true });

    const complete = cli(project, 'install');
    expect(complete.status).toBe(0);
    expect(complete.stdout).toContain('Every package this project pins is installed (1).');

    const pins = config();
    pins.dependencies['@acme/gears'] = { version: '1.2.0', integrity: pins.dependencies['@acme/kit'].integrity };
    fs.writeFileSync(path.join(project, 'fluidcad.json'), JSON.stringify(pins, null, 2));
    const missing = cli(project, 'install');
    expect(missing.status).toBe(1);
    expect(missing.stdout).toContain(`This project pins 1 package that isn't installed; downloading from ${offlineHub}.`);
    expect(missing.stderr).toContain(`Couldn't install 1 package:\n  @acme/gears 1.2.0: Couldn't reach ${offlineHub}: ECONNREFUSED.`);
  });

  it('asks the hub for every missing pin, an @local one left by H8c included (the hub never has one)', async () => {
    const pins = config();
    pins.dependencies = { '@local/kit': { version: '0.1.0', integrity: 'sha256-' + 'A'.repeat(42) + 'E=' } };
    fs.writeFileSync(path.join(project, 'fluidcad.json'), JSON.stringify(pins, null, 2));
    const run = cli(project, 'install');
    expect(run.status).toBe(1);
    expect(run.stdout).toContain(`This project pins 1 package that isn't installed; downloading from ${offlineHub}.`);
    expect(run.stderr).toContain(`  @local/kit 0.1.0: Couldn't reach ${offlineHub}: ECONNREFUSED.`);
    expect(run.stderr).not.toContain('from a file');
  });

  it('outside a project says where to run it, naming no file', () => {
    const run = cli(outside, 'install');
    expect(run.status).toBe(1);
    expect(run.stderr.trim()).toBe('Run `fluidcad install` in a project: it installs the packages the project pins. To install a package, pass its name.');
  });
});

describe('fluidcad remove and fluidcad packages', () => {
  it('lists the library, and in a project its copy and pins', async () => {
    await seed({ pin: true });

    const listed = cli(project, 'packages');
    expect(listed.status).toBe(0);
    expect(listed.stdout).toContain(`Your library: ${library}\n  @acme/kit 0.1.0  1 feature, 0 parts,`);
    expect(listed.stdout).toContain(`This project's packages folder: ${path.join(project, 'packages')}\n  (empty)`);
    expect(listed.stdout).toContain('Pinned in fluidcad.json:\n  @acme/kit 0.1.0  from your library');

    expect(cli(outside, 'packages').stdout).not.toContain('Pinned in fluidcad.json');
  });

  it('removes from the library and says when the project still pins it', async () => {
    await seed({ pin: true });

    const run = cli(project, 'remove', '@acme/kit@0.1.0');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`Removed @acme/kit 0.1.0 from your library (${library}).`);
    expect(run.stdout).toContain('This project still pins @acme/kit 0.1.0, which is no longer installed: its models will ask for it until you install it again (fluidcad install).');
    expect(fs.existsSync(installedKit())).toBe(false);
    // The pin is the project's; remove leaves it.
    expect(config().dependencies['@acme/kit'].version).toBe('0.1.0');

    const again = cli(project, 'remove', '@acme/kit');
    expect(again.status).toBe(1);
    expect(again.stderr).toContain("@acme/kit isn't in your library.");
  });

  it('removes a project copy with --project', async () => {
    await seed({ target: 'project' });
    const run = cli(project, 'remove', '@acme/kit@0.1.0', '--project');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("Removed @acme/kit 0.1.0 from this project's packages folder");
    expect(fs.existsSync(path.join(project, 'packages', '@acme'))).toBe(false);
  });
});
