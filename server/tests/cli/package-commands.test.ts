import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { PackageName } from '../../src/packages/package-name.ts';
import { FakeHub } from '../fixtures/fake-hub.ts';

/**
 * `fluidcad package init` and `fluidcad version`, run as the user runs
 * them: the real `bin/fluidcad.js` in a child process. The CLI imports the
 * compiled server out of `server/dist`, so these need `npm run build:server`
 * after a server change — the rules themselves are covered against the
 * sources in `server/tests/packages/package-authoring.test.ts`.
 *
 * FLUIDCAD_HOME is a temp folder (signed out unless a test writes its
 * `credentials.json`), FLUIDCAD_HUB_TOKEN is cleared and FLUIDCAD_HUB_URL
 * points at an in-process FakeHub, so `package init`'s handle lookup never
 * reads the user's own credentials or reaches a network.
 */

const REPO = path.resolve(import.meta.dirname, '../../..');
const CLI = path.join(REPO, 'bin', 'fluidcad.js');
const COMPILED = path.join(REPO, 'server', 'dist', 'packages', 'package-authoring.js');

let workspace: string;
let library: string;
let home: string;
let hub: FakeHub;

type Run = { status: number | null; stdout: string; stderr: string };

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const vars: NodeJS.ProcessEnv = { ...process.env };
  delete vars.FLUIDCAD_HUB_TOKEN;
  // Nothing here touches the user library; point it at a temp directory anyway.
  return { ...vars, FLUIDCAD_PACKAGES: library, FLUIDCAD_HOME: home, FLUIDCAD_HUB_URL: hub.origin, ...extra };
}

function cli(...args: string[]): Run {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd: workspace, encoding: 'utf8', env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** The CLI spawned, not run synchronously: the in-process FakeHub must keep answering. */
function cliAsync(args: string[], extra: Record<string, string> = {}): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: workspace, env: env(extra), stdio: ['ignore', 'pipe', 'pipe'] });
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

/** A stored credential for `origin` (the FakeHub by default), as `fluidcad login` leaves it. */
function signIn(handle: string | null, origin = hub.origin): void {
  fs.writeFileSync(path.join(home, 'credentials.json'), JSON.stringify({ hubs: { [origin]: { token: 'fch_stored', tokenId: 't1', handle, email: 'acme@example.com' } } }, null, 2), { mode: 0o600 });
}

/** A local port nothing listens on: a hub that doesn't answer. */
async function closedPort(): Promise<string> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const offline = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return offline;
}

function write(rel: string, contents = ''): void {
  const abs = path.join(workspace, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contents);
}

function readConfig(): Record<string, any> {
  return JSON.parse(fs.readFileSync(path.join(workspace, 'fluidcad.json'), 'utf8'));
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
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-cli-package-'));
  library = fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-cli-library-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-cli-home-'));
  write('fluidcad.json', JSON.stringify({ engine: '0.0.46', unit: 'in' }, null, 2) + '\n');
  write('init.js');
  write('standoff.feature.js');
  write('features/boss.feature.js');
  write('plate.part.js');
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(library, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

describe('fluidcad package init', () => {
  it('writes the block with the name and version 1.0.0, prints it, and says what the folders export', () => {
    const run = cli('package', 'init', '--name', '@acme/demo');

    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    const block = { name: '@acme/demo', version: '1.0.0' };
    expect(readConfig()).toEqual({ engine: '0.0.46', unit: 'in', package: block });
    expect(run.stdout).toContain('Wrote the "package" block to');
    expect(run.stdout).not.toContain('Named it');
    expect(run.stdout).toContain(JSON.stringify(block, null, 2).split('\n').map((l) => `  ${l}`).join('\n'));
    expect(run.stdout).toContain('The package exports what features/, parts/ and assemblies/ hold. Today: features/ 1 module, parts/ none, assemblies/ none.');
    expect(readConfig().package.exports).toBeUndefined();
    // Nothing is written next to the block, and no handle was looked up.
    expect(fs.existsSync(path.join(workspace, 'package.json'))).toBe(false);
    expect(hub.requests).toEqual([]);
  });

  it('says where modules go when the folders hold nothing yet', () => {
    fs.rmSync(path.join(workspace, 'features'), { recursive: true });

    const run = cli('package', 'init', '--name', '@acme/demo');

    expect(run.status).toBe(0);
    expect(run.stdout).toContain(
      'Put the package\'s feature modules in features/, its parts in parts/ and its assemblies in assemblies/: the package exports what those folders hold.',
    );
  });

  it('takes the workspace from --workspace', () => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-cli-cwd-'));
    try {
      const result = spawnSync(process.execPath, [CLI, 'package', 'init', '-n', '@acme/demo', '-w', workspace], {
        cwd: elsewhere, encoding: 'utf8', env: env(),
      });
      expect(result.status).toBe(0);
      expect(readConfig().package.name).toBe('@acme/demo');
      expect(fs.existsSync(path.join(elsewhere, 'fluidcad.json'))).toBe(false);
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('refuses a bad name with the rule, exit 1, and leaves the file alone', () => {
    const run = cli('package', 'init', '--name', '@acme/3d-demo');

    expect(run.status).toBe(1);
    expect(run.stderr.trim()).toBe(`"@acme/3d-demo" is not a package name: ${PackageName.RULE}.`);
    expect(readConfig()).toEqual({ engine: '0.0.46', unit: 'in' });
  });

  it('signed out, refuses a name without its scope, saying to add the hub handle (HD30)', () => {
    const run = cli('package', 'init', '--name', 'demo');

    expect(run.status).toBe(1);
    expect(run.stderr.trim()).toBe('"name" "demo" needs your hub handle as its scope: write "@<your-handle>/demo".');
    expect(readConfig()).toEqual({ engine: '0.0.46', unit: 'in' });
    expect(hub.requests).toEqual([]);
  });

  it('signed in, scopes a name without one with the stored handle, says so, and asks the hub nothing', async () => {
    signIn('acme');
    const run = await cliAsync(['package', 'init', '--name', 'demo']);

    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`Named it @acme/demo: your handle on ${hub.origin}.\nWrote the "package" block to`);
    expect(readConfig().package).toEqual({ name: '@acme/demo', version: '1.0.0' });
    expect(hub.requests).toEqual([]);
  });

  it('takes a scoped name as typed when signed in, even under another scope', async () => {
    signIn('acme');
    const run = await cliAsync(['package', 'init', '--name', '@bea-tools/demo']);
    expect(run.status).toBe(0);
    expect(run.stdout).not.toContain('Named it');
    expect(readConfig().package.name).toBe('@bea-tools/demo');
  });

  it('with only FLUIDCAD_HUB_TOKEN, asks GET /me for the handle', async () => {
    const { token } = hub.issueToken({ kind: 'personal', scopes: ['publish'] });
    const run = await cliAsync(['package', 'init', '--name', 'demo'], { FLUIDCAD_HUB_TOKEN: token });

    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`Named it @acme/demo: your handle on ${hub.origin}.`);
    expect(hub.requestsTo('/api/v1/me')).toHaveLength(1);
    expect(readConfig().package.name).toBe('@acme/demo');
  });

  it('asks GET /me when the stored credential names no handle, and takes --hub for which hub', async () => {
    const { token } = hub.issueToken({ kind: 'cli', scopes: ['publish'] });
    fs.writeFileSync(path.join(home, 'credentials.json'), JSON.stringify({ hubs: { [hub.origin]: { token, tokenId: null, handle: null, email: null } } }));
    const run = await cliAsync(['package', 'init', '--name', 'demo', '--hub', hub.origin], { FLUIDCAD_HUB_URL: 'https://hub.example.invalid' });

    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`Named it @acme/demo: your handle on ${hub.origin}.`);
    expect(hub.requestsTo('/api/v1/me')).toHaveLength(1);
  });

  it('counts a hub that does not answer, or refuses the token, as signed out', async () => {
    const offline = await closedPort();
    const unreachable = await cliAsync(['package', 'init', '--name', 'demo'], { FLUIDCAD_HUB_TOKEN: 'fch_whatever', FLUIDCAD_HUB_URL: offline });
    expect(unreachable.status).toBe(1);
    expect(unreachable.stderr.trim()).toBe('"name" "demo" needs your hub handle as its scope: write "@<your-handle>/demo".');

    const refused = await cliAsync(['package', 'init', '--name', 'demo'], { FLUIDCAD_HUB_TOKEN: 'fch_not-a-token' });
    expect(refused.status).toBe(1);
    expect(refused.stderr.trim()).toBe('"name" "demo" needs your hub handle as its scope: write "@<your-handle>/demo".');
    expect(readConfig()).toEqual({ engine: '0.0.46', unit: 'in' });
  });

  it('asks for --name when there is no terminal to prompt on', () => {
    const run = cli('package', 'init');

    expect(run.status).toBe(1);
    expect(run.stderr.trim()).toBe('Pass the package name with --name, such as --name @acme/feature-tests.');
    expect(readConfig().package).toBeUndefined();
  });

  it('refuses a workspace that is already a package', () => {
    expect(cli('package', 'init', '--name', '@acme/demo').status).toBe(0);

    const run = cli('package', 'init', '--name', '@acme/other');

    expect(run.status).toBe(1);
    expect(run.stderr).toContain('already the package @acme/demo 1.0.0');
    expect(readConfig().package.name).toBe('@acme/demo');
  });
});

describe('fluidcad version', () => {
  it('bumps patch, minor and major, and sets an exact version, printing each change', () => {
    expect(cli('package', 'init', '--name', '@acme/demo').status).toBe(0);

    const steps: [string, string][] = [
      ['patch', '@acme/demo 1.0.0 → 1.0.1'],
      ['minor', '@acme/demo 1.0.1 → 1.1.0'],
      ['major', '@acme/demo 1.1.0 → 2.0.0'],
      ['2.1.0-beta.1', '@acme/demo 2.0.0 → 2.1.0-beta.1'],
      ['minor', '@acme/demo 2.1.0-beta.1 → 2.1.0'],
    ];
    for (const [spec, printed] of steps) {
      const run = cli('version', spec);
      expect(run.stderr).toBe('');
      expect(run.status).toBe(0);
      expect(run.stdout.trim()).toBe(printed);
    }

    const config = readConfig();
    expect(config.package.version).toBe('2.1.0');
    expect(config).toMatchObject({ engine: '0.0.46', unit: 'in' });
    expect(config.package).toEqual({ name: '@acme/demo', version: '2.1.0' });
  });

  it('refuses outside a package', () => {
    const run = cli('version', 'patch');

    expect(run.status).toBe(1);
    expect(run.stderr.trim()).toBe("This workspace isn't a package — run `fluidcad package init` first.");
  });

  it('refuses a spec that is neither a bump nor a version', () => {
    expect(cli('package', 'init', '--name', '@acme/demo').status).toBe(0);

    const run = cli('version', '1.2');

    expect(run.status).toBe(1);
    expect(run.stderr).toContain('"1.2" is not a version or a bump');
    expect(readConfig().package.version).toBe('1.0.0');
  });

  it('needs the bump argument', () => {
    const run = cli('version');

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("missing required argument 'bump'");
  });
});
