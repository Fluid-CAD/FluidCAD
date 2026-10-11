import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { FakeHub, type FakeHubVersion } from '../fixtures/fake-hub.ts';

/**
 * `fluidcad publish`, run as the user runs it: the real `bin/fluidcad.js` in
 * a child process, against the in-process `FakeHub`, over a copy of
 * fixtures/package-workspace (`@acme/kit` 0.1.0). FLUIDCAD_HOME and
 * FLUIDCAD_PACKAGES are temp directories, and `FLUIDCAD_NO_BROWSER=1` keeps
 * the CLI from opening the wizard. The CLI imports the compiled server out of
 * `server/dist`, so these need `npm run build:server` after a server change;
 * the publisher's rules are covered against the sources in
 * `server/tests/hub/hub-publisher.test.ts`.
 *
 * Each publish packs the workspace for real (the engine boots in the child),
 * so only a few tests here go that far.
 */

const REPO = path.resolve(import.meta.dirname, '../../..');
const CLI = path.join(REPO, 'bin', 'fluidcad.js');
const COMPILED = path.join(REPO, 'server', 'dist', 'hub', 'hub-publisher.js');
const FIXTURE = path.join(REPO, 'server', 'tests', 'fixtures', 'package-workspace');
const PROXY_KEYS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy'];
const NAME = '@acme/kit';

type Run = { status: number | null; stdout: string; stderr: string };

let hub: FakeHub;
let scratch: string;
let workspace: string;
let home: string;
let library: string;
let token: string;

function cli(args: string[], extraEnv: Record<string, string> = {}): Promise<Run> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [...PROXY_KEYS, 'FLUIDCAD_HUB_TOKEN']) {
    delete env[key];
  }
  Object.assign(env, {
    FLUIDCAD_HOME: home,
    FLUIDCAD_PACKAGES: library,
    FLUIDCAD_HUB_URL: hub.origin,
    FLUIDCAD_HUB_TOKEN: token,
    FLUIDCAD_NO_BROWSER: '1',
    ...extraEnv,
  });
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
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

function hold(versions: FakeHubVersion[]): void {
  hub.packages.set(NAME, { status: 'active', versions });
}

function uploadPath(version = '0.1.0'): string {
  return `/api/v1/packages/${NAME}/versions/${version}`;
}

/** Nothing of a publish's scratch directory is left in FLUIDCAD_HOME. */
function expectNoScratch(): void {
  expect(fs.existsSync(path.join(home, '.tmp'))).toBe(false);
}

beforeAll(async () => {
  expect(fs.existsSync(COMPILED), 'server/dist is not built: run `npm run build:server`').toBe(true);
  hub = await FakeHub.start();
  scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fluidcad-cli-publish-'));
  workspace = path.join(scratch, 'kit');
  fs.cpSync(FIXTURE, workspace, { recursive: true });
});

afterAll(async () => {
  await hub.stop();
  fs.rmSync(scratch, { recursive: true, force: true });
});

beforeEach(() => {
  hub.reset();
  token = hub.issueToken({ kind: 'cli', scopes: ['publish'] }).token;
  home = fs.mkdtempSync(path.join(scratch, 'home-'));
  library = fs.mkdtempSync(path.join(scratch, 'library-'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(library, { recursive: true, force: true });
});

describe('fluidcad publish', () => {
  it('uploads what `fluidcad pack` makes, and a first version prints and opens the wizard URL', async () => {
    const out = path.join(scratch, 'out');
    fs.mkdirSync(out, { recursive: true });
    const pack = await cli(['pack', '-o', out]);
    expect(pack.status).toBe(0);
    const archive = fs.readFileSync(path.join(out, 'acme-kit-0.1.0.fluidpkg'));

    const run = await cli(['publish', '-y']);
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(hub.uploads).toHaveLength(1);
    expect(Buffer.compare(hub.uploads[0].bytes, archive)).toBe(0);
    const integrity = String(hub.uploads[0].headers['x-fluidcad-integrity']);
    expect(integrity).toMatch(/^sha256-[A-Za-z0-9+/]+=*$/);

    expect(run.stdout).toContain(`Publishing ${NAME} 0.1.0 on ${hub.origin} as @acme:\n`);
    expect(run.stdout).toContain('  features/   2 features');
    expect(run.stdout).toContain('  parts/      1 part');
    expect(run.stdout).toContain('  assemblies/ 0 assemblies');
    expect(run.stdout).toContain(`  integrity: ${integrity}`);
    expect(run.stdout).toContain('  first version: you finish publishing in your browser (screenshots, license, release notes)');
    expect(run.stdout).toContain(`✓ Uploaded ${NAME}@0.1.0 · ${integrity} · finish publishing in your browser: ${hub.origin}/publish/${NAME}/0.1.0`);
    expectNoScratch();
  }, 120_000);

  it('prints the review line for a later version, with its notes', async () => {
    hold([{ version: '0.0.9', status: 'published' }]);
    const run = await cli(['publish', '-y', '--notes', 'A spacer']);
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    const integrity = String(hub.uploads[0].headers['x-fluidcad-integrity']);
    expect(hub.uploads[0].headers['x-fluidcad-release-notes']).toBe('A%20spacer');
    expect(run.stdout).toContain('  goes straight to review: an admin approves it before it is public');
    expect(run.stdout).toContain(`✓ Submitted ${NAME}@0.1.0 for review · ${integrity} · ${hub.origin}/${NAME}/status`);
  }, 120_000);

  it('sends ?dryRun=1 for --dry-run and stores nothing', async () => {
    const run = await cli(['publish', '--dry-run']);
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(hub.requestsTo(uploadPath())[0].query).toBe('?dryRun=1');
    expect(hub.packages.has(NAME)).toBe(false);
    expect(run.stdout).toMatch(new RegExp(`✓ Dry run: ${hub.origin.replace(/[.]/g, '\\.')} accepts @acme/kit@0\\.1\\.0 · sha256-\\S+ · it would be a draft you finish in your browser\\. Nothing was stored\\.`));
  }, 120_000);

  it('asks before uploading, and without a terminal needs -y: nothing is sent, nothing is left', async () => {
    const run = await cli(['publish']);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('Pass -y to go ahead without being asked (this is not an interactive terminal). Nothing was sent.');
    expect(run.stdout).toContain(`Publishing ${NAME} 0.1.0 on ${hub.origin} as @acme:\n`);
    expect(hub.uploads).toHaveLength(0);
    expectNoScratch();
  }, 120_000);

  it('refuses another open version with the --status/--withdraw hint, before packing', async () => {
    hold([{ version: '0.0.9', status: 'published' }, { version: '0.0.10', status: 'in_review' }]);
    const run = await cli(['publish', '-y']);
    expect(run.status).toBe(1);
    expect(run.stderr.trim()).toBe(
      `${NAME}@0.0.10 is in review: submit, withdraw or finish it before you upload another version. ` +
        'See it with `fluidcad publish --status`, or withdraw it with `fluidcad publish --withdraw`.',
    );
    expect(run.stdout).not.toContain('Packing');
    expect(hub.uploads).toHaveLength(0);
    expectNoScratch();
  }, 120_000);

  it('refuses a CLI older than the hub accepts, and a signed-out machine, before packing', async () => {
    hub.minCliVersion = '99.0.0';
    const old = await cli(['publish', '-y']);
    expect(old.status).toBe(1);
    expect(old.stderr).toMatch(/^This FluidCAD is \d+\.\d+\.\d+, and http:\/\/127\.0\.0\.1:\d+ takes uploads from 99\.0\.0 or newer: update FluidCAD, then publish again\.\n$/);
    expect(old.stdout).not.toContain('Packing');

    hub.minCliVersion = null;
    const out = await cli(['publish', '-y'], { FLUIDCAD_HUB_TOKEN: '' });
    expect(out.status).toBe(1);
    expect(out.stderr.trim()).toBe(`Not signed in to ${hub.origin}. Run \`fluidcad login\` first.`);
    expect(hub.uploads).toHaveLength(0);
  });

  it('refuses an account that is not a publisher with the invite-only sentence', async () => {
    hub.user = { ...hub.user, canPublish: false };
    token = hub.issueToken({ kind: 'cli', scopes: ['publish'] }).token;
    const run = await cli(['publish', '-y']);
    expect(run.status).toBe(1);
    expect(run.stderr.trim()).toBe(`Publishing on ${hub.origin} is invite-only for now, and @acme is not a publisher yet. The hub's admins grant publishing; nothing was uploaded.`);
    expect(hub.uploads).toHaveLength(0);
  });

  it("prints the hub's own refusal with its next step", async () => {
    hub.nextUpload = { error: { status: 409, code: 'version-not-greater', message: '0.1.0 is not greater than 0.3.0, the highest version of @acme/kit published so far: bump the version.' } };
    const run = await cli(['publish', '-y']);
    expect(run.status).toBe(1);
    expect(run.stderr.trim()).toBe(
      '0.1.0 is not greater than 0.3.0, the highest version of @acme/kit published so far: bump the version. ' +
        'Bump the version with `fluidcad version patch` (or minor, or major), then publish again.',
    );
    expectNoScratch();
  }, 120_000);

  it("refuses a package under another handle's scope before reading, packing or uploading anything (HD30), dry run too", async () => {
    const theirs = path.join(scratch, 'bea-kit');
    fs.cpSync(FIXTURE, theirs, { recursive: true });
    const config = JSON.parse(fs.readFileSync(path.join(theirs, 'fluidcad.json'), 'utf8'));
    config.package.name = '@bea-tools/kit';
    fs.writeFileSync(path.join(theirs, 'fluidcad.json'), JSON.stringify(config, null, 2));

    for (const args of [['publish', '-y', '-w', theirs], ['publish', '--dry-run', '-w', theirs]]) {
      const run = await cli(args);
      expect(run.status).toBe(1);
      expect(run.stderr.trim()).toBe(
        `@bea-tools/kit is under @bea-tools, but you are signed in to ${hub.origin} as @acme, and you can only publish under your own handle: `
          + 'name the package "@acme/kit" in fluidcad.json, or sign in as @bea-tools.',
      );
    }
    expect(hub.uploads).toHaveLength(0);
    expect(hub.requests.filter((r) => r.method === 'PUT')).toEqual([]);
    expect(hub.requests.filter((r) => r.path.startsWith('/api/v1/packages/'))).toEqual([]);
    expectNoScratch();
  });

  it('has no model flags any more', async () => {
    const run = await cli(['publish', '--new-model']);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("unknown option '--new-model'");
    expect(hub.requests).toHaveLength(0);
  });
});

describe('fluidcad publish --status', () => {
  it('says when the package is not on the hub yet, asking about the name fluidcad.json writes with no GET /me', async () => {
    const run = await cli(['publish', '--status']);
    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toBe(`${NAME} is not on ${hub.origin} yet. \`fluidcad publish\` uploads its first version.`);
    expect(hub.requestsTo('/api/v1/me')).toEqual([]);
  });

  it('gives a draft its wizard URL', async () => {
    hold([{ version: '0.1.0', status: 'draft' }]);
    const run = await cli(['publish', '--status']);
    expect(run.stdout).toContain(`${NAME}@0.1.0 is a draft · finish publishing in your browser: ${hub.origin}/publish/${NAME}/0.1.0`);
    expect(run.stdout).toContain('  a draft nobody touches is deleted on 2026-11-09');
  });

  it('shows a version in review, and the latest published one', async () => {
    hold([
      { version: '0.0.9', status: 'published', publishedAt: '2026-10-02T00:00:00.000Z', integrity: 'sha256-a=' },
      { version: '0.1.0', status: 'in_review', submittedAt: '2026-10-09T08:00:00.000Z' },
    ]);
    const run = await cli(['publish', '--status']);
    expect(run.stdout).toContain(`${NAME}@0.1.0 is in review since 2026-10-09 · ${hub.origin}/${NAME}/status`);
    expect(run.stdout).toContain('  latest published 0.0.9 on 2026-10-02 · sha256-a=');
  });

  it('gives a rejection its reason', async () => {
    hold([{ version: '0.0.9', status: 'published' }, { version: '0.1.0', status: 'rejected', reviewNote: 'The spacer has no fillet.' }]);
    const run = await cli(['publish', '--status']);
    expect(run.stdout).toContain(`${NAME}@0.1.0 was rejected: The spacer has no fillet.`);
    expect(run.stdout).toContain('Fix it, then `fluidcad publish` again (the same version number is free).');
  });

  it('shows the latest published version when nothing is open', async () => {
    hold([{ version: '0.1.0', status: 'published', publishedAt: '2026-10-03T00:00:00.000Z', integrity: 'sha256-b=' }]);
    const run = await cli(['publish', '--status']);
    expect(run.stdout.trim()).toBe(`${NAME}: latest published 0.1.0 on 2026-10-03 · sha256-b=`);
  });
});

describe('fluidcad publish --withdraw', () => {
  it('withdraws the open version with -y', async () => {
    hold([{ version: '0.0.9', status: 'published' }, { version: '0.1.0', status: 'in_review' }]);
    const run = await cli(['publish', '--withdraw', '-y']);
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`${NAME}@0.1.0 is in review on ${hub.origin}. Withdrawing deletes it there; its number is free again.`);
    expect(run.stdout).toContain(`✓ Withdrew ${NAME}@0.1.0 from ${hub.origin}.`);
    expect(hub.requests.filter((r) => r.method === 'DELETE').map((r) => r.path)).toEqual([uploadPath()]);
  });

  it('asks first: without a terminal and without -y, nothing is withdrawn', async () => {
    hold([{ version: '0.1.0', status: 'draft' }]);
    const run = await cli(['publish', '--withdraw']);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('Pass -y to go ahead without being asked');
    expect(hub.requests.filter((r) => r.method === 'DELETE')).toHaveLength(0);
  });

  it('says when there is nothing to withdraw', async () => {
    const run = await cli(['publish', '--withdraw', '-y']);
    expect(run.status).toBe(1);
    expect(run.stderr.trim()).toBe(`${NAME} has no draft or version in review on ${hub.origin} to withdraw.`);
  });

  it('refuses --status and --withdraw together', async () => {
    const run = await cli(['publish', '--status', '--withdraw']);
    expect(run.status).toBe(1);
    expect(run.stderr.trim()).toBe('Pass --status or --withdraw, not both.');
  });
});
