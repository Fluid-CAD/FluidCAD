import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { spawn } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { PackageRoots } from '../../src/packages/package-roots.ts';
import { ArchiveFixture } from '../packages/archive-fixture.ts';
import { LibrarySeed } from '../packages/library-seed.ts';
import { FakeHub } from '../fixtures/fake-hub.ts';
import { SearchFixture } from '../fixtures/search-fixture.ts';

/**
 * `fluidcad search` (hub-plan Stage H10, from the user's search design of
 * 2026-10-11), run as the user runs it: the real `bin/fluidcad.js` in a
 * child process against the in-process FakeHub, which serves a fixture
 * `SearchResponse` and records the query. FLUIDCAD_PACKAGES, FLUIDCAD_HOME
 * and HOME are temp folders. The CLI imports the compiled server out of
 * `server/dist`: run `npm run build:server` after a server change.
 */

const REPO = path.resolve(import.meta.dirname, '../../..');
const CLI = path.join(REPO, 'bin', 'fluidcad.js');
const COMPILED = path.join(REPO, 'server', 'dist', 'hub', 'hub-search-text.js');
const PROXY_KEYS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy', 'FLUIDCAD_HUB_TOKEN'];

type Run = { status: number | null; stdout: string; stderr: string };

let hub: FakeHub;
let tmp: string;
let project: string;
let library: string;
let savedPackages: string | undefined;

function cli(cwd: string, args: string[], extraEnv: Record<string, string> = {}): Promise<Run> {
  const home = path.join(tmp, 'home');
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of PROXY_KEYS) {
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
    const child = spawn(process.execPath, [CLI, 'search', ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
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

async function closedPort(): Promise<string> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

async function kit(version: string): Promise<Buffer> {
  const files = { ...ArchiveFixture.defaultFiles(), 'standoff.feature.js': `export const standoff = () => '${version}';\n` };
  return ArchiveFixture.zip({ version, files });
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
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-cli-search-')));
  project = path.join(tmp, 'project');
  library = path.join(tmp, 'library');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'fluidcad.json'), JSON.stringify({ engine: ArchiveFixture.ENGINE }, null, 2) + '\n');
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

describe('fluidcad search', () => {
  it("maps every flag to the hub's parameter, as repeated keys, with this engine and SDK, compatible-only and no sort", async () => {
    const run = await cli(tmp, [
      '@acme', 'standoff',
      '--contents', 'features,parts',
      '--keyword', 'pcb', '--keyword', 'fasteners',
      '--units', 'metric',
      '--license', 'MIT', '--license', 'Apache-2.0',
      '--page', '2', '--limit', '5',
    ]);
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    const sent = hub.searchQueries()[0];
    expect(sent.get('q')).toBe('@acme standoff');
    expect(sent.getAll('contents')).toEqual(['features', 'parts']);
    expect(sent.getAll('keyword')).toEqual(['pcb', 'fasteners']);
    expect(sent.getAll('units')).toEqual(['metric']);
    expect(sent.getAll('license')).toEqual(['MIT', 'Apache-2.0']);
    expect(sent.get('page')).toBe('2');
    expect(sent.get('limit')).toBe('5');
    expect(sent.get('engine')).toBe(ArchiveFixture.ENGINE);
    expect(sent.get('sdk')).toBe('1');
    expect(sent.get('compatible')).toBe('true');
    expect(sent.has('sort')).toBe(false);
    expect(hub.searchQueries()[0].toString()).not.toContain('includeIncompatible');
    expect(run.stdout).toBe('No packages match.\n');
  });

  it('sends no compatible filter with --include-incompatible, and the sort with --sort', async () => {
    await cli(tmp, ['--include-incompatible', '--sort', 'newest']);
    const sent = hub.searchQueries()[0];
    expect(sent.has('compatible')).toBe(false);
    expect(sent.get('sort')).toBe('newest');
    expect(sent.get('engine')).toBe(ArchiveFixture.ENGINE);
    expect(sent.get('sdk')).toBe('1');
  });

  it('prints each row with its marks, why it is incompatible only when it is (a newer FluidCAD or another feature SDK), deprecated, and the capped footer', async () => {
    await LibrarySeed.install(await kit('0.1.0'), { project, pin: true });
    hub.searchAnswer = SearchFixture.answer([
      SearchFixture.row({ origin: hub.origin, version: '0.2.0', chips: ['Standoff', 'Bolt circle', 'Boss'], moreFeatures: 2, counts: { features: 5, parts: 5, assemblies: 1 }, likes: 3, installs: 1200 }),
      SearchFixture.row({ origin: hub.origin, fullName: '@crank/flywheel', version: '1.0.0', compatible: false, minEngine: '0.0.99', chips: ['Flywheel'], counts: { features: 1, parts: 1, assemblies: 0 }, license: 'Apache-2.0' }),
      SearchFixture.row({ origin: hub.origin, fullName: '@pivot/hinges', version: '1.0.0', compatible: false, minEngine: '0.0.46', sdkVersion: 2, chips: ['Hinge'] }),
      SearchFixture.row({ origin: hub.origin, fullName: '@amberlight/lantern', version: '2.0.0', description: 'Lantern\nshades.', deprecated: 'Use @amberlight/lumen instead.', minEngine: '0.0.99', compatible: true }),
    ], { total: 1000, capped: true, limit: 4 });
    const run = await cli(project, ['--include-incompatible', '--limit', '4']);
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).toBe([
      '@acme/kit 0.2.0 · installed 0.1.0 · pinned 0.1.0 · update available',
      '  A test kit',
      '  Standoff, Bolt circle, Boss +2 · 5 features, 5 parts, 1 assembly · 3 likes · 1,200 installs · MIT',
      '',
      '@crank/flywheel 1.0.0 · needs FluidCAD 0.0.99+',
      '  A test kit',
      '  Flywheel · 1 feature, 1 part · 0 likes · 0 installs · Apache-2.0',
      '',
      '@pivot/hinges 1.0.0 · needs feature SDK 2 (this FluidCAD has 1)',
      '  A test kit',
      '  Hinge · 1 feature · 0 likes · 0 installs · MIT',
      '',
      '@amberlight/lantern 2.0.0 · deprecated: Use @amberlight/lumen instead.',
      '  Lantern shades.',
      '  Standoff · 1 feature · 0 likes · 0 installs · MIT',
      '',
      '1–4 of 1,000+ · --page 2 for more',
      '',
    ].join('\n'));
  });

  it("--json prints the engine's annotated answer: proxy paths, no avatars, the local marks, each row's minEngine and sdkVersion", async () => {
    await LibrarySeed.install(await kit('0.2.0'));
    const card = hub.addMedia('@acme/kit', Buffer.from('png'));
    hub.searchAnswer = SearchFixture.answer([
      SearchFixture.row({ origin: hub.origin, version: '0.2.0', cardId: card }),
      SearchFixture.row({ origin: hub.origin, fullName: '@pivot/hinges', version: '1.0.0', compatible: false, minEngine: '0.0.46', sdkVersion: 2 }),
    ]);
    const run = await cli(tmp, ['standoff', '--json']);
    expect(run.status).toBe(0);
    const answer = JSON.parse(run.stdout);
    expect(answer.total).toBe(2);
    expect(answer.facets).toEqual((hub.searchAnswer as any).facets);
    const [kitRow, hingesRow] = answer.results;
    expect([kitRow.minEngine, kitRow.sdkVersion, kitRow.compatible]).toEqual(['0.0.46', 1, true]);
    expect([hingesRow.minEngine, hingesRow.sdkVersion, hingesRow.compatible]).toEqual(['0.0.46', 2, false]);
    expect(kitRow.cardImageUrl).toBe(`api/hub/media/@acme/kit/${card}`);
    expect(kitRow.features[0].iconUrl).toBe('api/hub/files/@acme/kit/0.2.0/standoff.svg');
    expect(kitRow.publisher).toEqual({ handle: 'acme' });
    expect(kitRow.local).toEqual({ installed: ['0.2.0'], pinned: null, updateAvailable: null });
    expect(run.stdout).not.toContain('avatar');
  });

  it("prints the hub's refusal with the field it names, and exits 1", async () => {
    hub.nextSearch = {
      status: 400,
      code: 'bad-request',
      message: 'The request is not valid.',
      details: { issues: [{ path: ['license', 0], code: 'custom', message: "Use one of the hub's licenses: MIT, Apache-2.0." }] },
    };
    const run = await cli(tmp, ['--license', 'WTFPL']);
    expect(run.status).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toBe("The request is not valid: license: Use one of the hub's licenses: MIT, Apache-2.0.\n");
  });

  it('says clearly when the hub cannot be reached, and exits 1', async () => {
    const offline = await closedPort();
    const run = await cli(tmp, ['standoff'], { FLUIDCAD_HUB_URL: offline });
    expect(run.status).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toBe(`Couldn't reach ${offline}: ECONNREFUSED. Nothing was searched: check the connection (or --hub) and try again.\n`);
  });

  it('takes --hub over FLUIDCAD_HUB_URL', async () => {
    const offline = await closedPort();
    const run = await cli(tmp, ['--hub', hub.origin], { FLUIDCAD_HUB_URL: offline });
    expect(run.status).toBe(0);
    expect(hub.searchQueries()).toHaveLength(1);
  });
});
