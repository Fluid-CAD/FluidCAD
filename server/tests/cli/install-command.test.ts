import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { ArchiveFixture } from '../packages/archive-fixture.ts';

/**
 * `fluidcad install`, `remove` and `packages`, run as the user runs them:
 * the real `bin/fluidcad.js` in a child process, over archives built in
 * memory. The CLI imports the compiled server out of `server/dist`, so
 * these need `npm run build:server` after a server change; the rules are
 * covered against the sources in `server/tests/packages/package-installer.test.ts`.
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
});

afterEach(() => {
  writable(tmp);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('fluidcad install <file>', () => {
  it('prints the consent summary, installs into the library and pins it when run in a project', () => {
    const run = cli(project, 'install', kit, '--library', '--yes');

    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('@acme/kit 0.1.0 — A test kit');
    expect(run.stdout).toContain('1 feature: acme.standoff (Standoff)');
    expect(run.stdout).toContain(`needs FluidCAD ${ArchiveFixture.ENGINE} or newer`);
    expect(run.stdout).toContain("A package's code runs in the FluidCAD engine with your permissions.");
    expect(run.stdout).toContain(`Installed @acme/kit 0.1.0 into your library (${installedKit()}).`);
    expect(run.stdout).toContain("Pinned @acme/kit 0.1.0 in this project's fluidcad.json.");
    expect(config()).toEqual({
      engine: ArchiveFixture.ENGINE,
      unit: 'mm',
      dependencies: { '@acme/kit': { version: '0.1.0', integrity: expect.stringMatching(/^sha256-/) } },
    });
    expect(fs.existsSync(path.join(installedKit(), 'manifest.json'))).toBe(true);
  });

  it('a second install of the same file changes nothing', () => {
    cli(project, 'install', kit, '--yes');
    const before = fs.readFileSync(path.join(project, 'fluidcad.json'), 'utf8');

    const run = cli(project, 'install', kit, '--yes');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('is already in your library');
    expect(run.stdout).toContain('with the same contents: nothing changed.');
    expect(run.stdout).toContain('This project already pins @acme/kit 0.1.0.');
    expect(fs.readFileSync(path.join(project, 'fluidcad.json'), 'utf8')).toBe(before);
  });

  it('outside a project it installs without pinning; --project there is refused', () => {
    const run = cli(outside, 'install', kit, '--yes');
    expect(run.status).toBe(0);
    expect(run.stdout).not.toContain('Pinned');
    expect(fs.readdirSync(outside)).toEqual([]);

    const refused = cli(outside, 'install', kit, '--project', '--yes');
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('this directory is not one');
  });

  it('installs into the project copy with --project', () => {
    const run = cli(project, 'install', kit, '--project', '--yes');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("Installed @acme/kit 0.1.0 into this project's packages folder");
    expect(fs.existsSync(path.join(project, 'packages', '@acme', 'kit', '0.1.0', 'index.js'))).toBe(true);
    expect(fs.existsSync(library)).toBe(false);
  });

  it('asks before installing, and without a terminal to ask on says to pass --yes', () => {
    const run = cli(project, 'install', kit);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('Pass --yes to install without being asked.');
    expect(run.stderr).toContain('Nothing was installed.');
    expect(fs.existsSync(installedKit())).toBe(false);
    expect(config().dependencies).toBeUndefined();
    // The inspected archive's scratch went with the refusal.
    expect(fs.readdirSync(library)).toEqual([]);
  });

  it('refuses the same version with one byte changed, and replaces it only when told to', async () => {
    cli(outside, 'install', kit, '--yes');
    const files = ArchiveFixture.defaultFiles();
    files['index.js'] = files['index.js'].replace('standoff }', 'standoff  }');
    const changed = await archive('acme-kit-0.1.0-changed.fluidpkg', { files });

    const refused = cli(outside, 'install', changed, '--yes');
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('@acme/kit 0.1.0 is already in your library with different contents');

    const replaced = cli(outside, 'install', changed, '--yes', '--replace');
    expect(replaced.status).toBe(0);
    expect(replaced.stdout).toContain('Replaced @acme/kit 0.1.0 in your library');
  });

  it('in a project pinning the version with other contents, the pin refuses first', async () => {
    cli(project, 'install', kit, '--yes');
    const files = ArchiveFixture.defaultFiles();
    files['index.js'] += '\n';
    const changed = await archive('acme-kit-0.1.0-changed.fluidpkg', { files });

    const run = cli(project, 'install', changed, '--yes', '--replace');
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('This project pins @acme/kit 0.1.0 with different contents');
  });

  it('refuses to change a pin to another version', async () => {
    cli(project, 'install', kit, '--yes');
    const newer = await archive('acme-kit-0.2.0.fluidpkg', { version: '0.2.0' });

    const run = cli(project, 'install', newer, '--yes');
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('This project pins @acme/kit 0.1.0; pinning 0.2.0 instead would change its geometry');
    expect(fs.existsSync(path.join(library, '@acme', 'kit', '0.2.0'))).toBe(false);
  });

  it('refuses an old model archive and both targets at once', async () => {
    const model = await archive('model.fluidpkg', { manifest: null, raw: { 'manifest.json': JSON.stringify({ schemaVersion: 3 }) } });
    const run = cli(project, 'install', model, '--yes');
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('This is a model archive, not a package');

    expect(cli(project, 'install', kit, '--library', '--project').stderr).toContain('Pass --library or --project, not both.');
  });
});

describe('fluidcad install <@scope/name>', () => {
  it('pins a library package into the project, and with --project copies it in', () => {
    cli(outside, 'install', kit, '--yes');

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

  it('with the hub offline, a name alone pins the library\'s newest version with a note, and says clearly why the rest fails', () => {
    cli(outside, 'install', kit, '--yes');
    const pinned = cli(project, 'install', '@acme/kit');
    expect(pinned.status).toBe(0);
    expect(pinned.stdout).toContain(`Couldn't reach ${offlineHub}, so this uses @acme/kit 0.1.0 from your library, the newest version there; the hub may have a newer one.`);
    expect(pinned.stdout).toContain('Pinned @acme/kit 0.1.0');

    const missing = cli(project, 'install', '@acme/gears');
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain(`Couldn't reach ${offlineHub}: ECONNREFUSED.`);
    expect(missing.stderr).toContain('a package already in your library installs without the hub, and `fluidcad install <file.fluidpkg>` installs from a file.');
    expect(config().dependencies['@acme/gears']).toBeUndefined();

    const already = cli(outside, 'install', '@acme/kit@0.1.0');
    expect(already.status).toBe(0);
    expect(already.stdout).toContain(`@acme/kit 0.1.0 is already in your library (${installedKit()}).`);
  });
});

describe('fluidcad install (no arguments)', () => {
  it('exits 0 when every pin is installed, and 1 listing the ones in neither root', () => {
    expect(cli(project, 'install').stdout).toContain('This project pins no packages.');
    cli(project, 'install', kit, '--yes');

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

  it('outside a project says where to run it', () => {
    const run = cli(outside, 'install');
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('Run `fluidcad install` in a project');
  });
});

describe('fluidcad remove and fluidcad packages', () => {
  it('lists the library, and in a project its copy and pins', () => {
    cli(project, 'install', kit, '--yes');

    const listed = cli(project, 'packages');
    expect(listed.status).toBe(0);
    expect(listed.stdout).toContain(`Your library: ${library}\n  @acme/kit 0.1.0  1 feature, 0 parts,`);
    expect(listed.stdout).toContain(`This project's packages folder: ${path.join(project, 'packages')}\n  (empty)`);
    expect(listed.stdout).toContain('Pinned in fluidcad.json:\n  @acme/kit 0.1.0  from your library');

    expect(cli(outside, 'packages').stdout).not.toContain('Pinned in fluidcad.json');
  });

  it('removes from the library and says when the project still pins it', () => {
    cli(project, 'install', kit, '--yes');

    const run = cli(project, 'remove', '@acme/kit@0.1.0');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`Removed @acme/kit 0.1.0 from your library (${library}).`);
    expect(run.stdout).toContain('This project still pins @acme/kit 0.1.0, which is no longer installed');
    expect(fs.existsSync(installedKit())).toBe(false);
    // The pin is the project's; remove leaves it.
    expect(config().dependencies['@acme/kit'].version).toBe('0.1.0');

    const again = cli(project, 'remove', '@acme/kit');
    expect(again.status).toBe(1);
    expect(again.stderr).toContain("@acme/kit isn't in your library.");
  });

  it('removes a project copy with --project', () => {
    cli(project, 'install', kit, '--project', '--yes');
    const run = cli(project, 'remove', '@acme/kit@0.1.0', '--project');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("Removed @acme/kit 0.1.0 from this project's packages folder");
    expect(fs.existsSync(path.join(project, 'packages', '@acme'))).toBe(false);
  });
});
