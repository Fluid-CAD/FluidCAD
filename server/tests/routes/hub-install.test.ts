import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import express from 'express';
import fs from 'fs';
import http from 'http';
import net from 'net';
import os from 'os';
import path from 'path';
import { createHubRouter } from '../../src/routes/hub.ts';
import { createPackagesRouter } from '../../src/routes/packages.ts';
import type { HubBridgeInstall } from '../../src/hub/hub-bridge.ts';
import { HubTransport } from '../../src/hub/hub-transport.ts';
import { PackageRoots } from '../../src/packages/package-roots.ts';
import { normalizePath } from '../../src/normalize-path.ts';
import { readProjectConfig } from '../../src/project-config.ts';
import { ArchiveFixture } from '../packages/archive-fixture.ts';
import { LibrarySeed } from '../packages/library-seed.ts';
import { FakeHub } from '../fixtures/fake-hub.ts';

/**
 * `POST /api/hub/install` (docs/agent-hub-plan.md): the whole install in one
 * call, as an agent asks for it through the MCP tool `install_package`, and
 * `GET /api/packages/file/…`, an installed package's text files. Against the
 * in-process FakeHub; FLUIDCAD_HOME, FLUIDCAD_PACKAGES and HOME are temp
 * folders, so nothing here can reach a real hub or a real library.
 */

const ENGINE = ArchiveFixture.ENGINE;
const KIT = '@acme/kit';
const PAGE = '# Standoff\n\nRaises a board off a face.\n';
const ENV_KEYS = ['FLUIDCAD_PACKAGES', 'FLUIDCAD_HOME', 'HOME', 'XDG_CONFIG_HOME', 'APPDATA'] as const;

let hub: FakeHub;
let saved: Record<string, string | undefined>;
let tmp: string;
let project: string;
let library: string;
let servers: http.Server[];
let installs: HubBridgeInstall[];

/** `@acme/kit` at `version`, with a doc page and a README; each version's feature module differs. */
async function kitArchive(version: string, manifest: Record<string, unknown> = {}, extra: Record<string, string | Uint8Array> = {}): Promise<Buffer> {
  return ArchiveFixture.zip({
    version,
    files: {
      ...ArchiveFixture.defaultFiles(),
      'standoff.feature.js': `export const standoff = () => '${version}';\n`,
      'docs/standoff.md': PAGE,
      'README.md': `# Kit ${version}\n`,
      ...extra,
    },
    manifest,
  });
}

async function publish(version: string, manifest: Record<string, unknown> = {}, extra: Record<string, string | Uint8Array> = {}) {
  return hub.addArchive(await kitArchive(version, manifest, extra));
}

async function serve(options: { workspacePath?: string; hubUrl?: string } = {}): Promise<string> {
  const workspacePath = options.workspacePath ?? project;
  const app = express();
  app.use(express.json());
  app.use('/api', createPackagesRouter({ workspacePath }));
  app.use('/api', createHubRouter({
    workspacePath,
    engineVersion: ENGINE,
    sdkVersion: 1,
    env: { FLUIDCAD_HUB_URL: options.hubUrl ?? hub.origin },
    transport: new HubTransport({ version: ENGINE, client: 'app', retryDelayMs: 1 }),
    onInstalled: (installed) => installs.push(installed),
  }));
  const server = http.createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return `http://127.0.0.1:${(server.address() as net.AddressInfo).port}/api`;
}

async function call(url: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(url, init);
  return { status: res.status, body: await res.json() };
}

function install(base: string, body: unknown) {
  return call(`${base}/hub/install`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

/** A local port nothing listens on: an offline hub. */
async function closedPort(): Promise<string> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

/** What an install left in a root's scratch. */
function scratch(root: string): string[] {
  try {
    return fs.readdirSync(path.join(root, '.tmp'));
  } catch {
    return [];
  }
}

/** The project's pins; null when it pins nothing. */
function pins(): Record<string, { version: string; integrity: string }> | null {
  return readProjectConfig(project).dependencies ?? null;
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
  hub = await FakeHub.start();
});

afterAll(async () => {
  await hub.stop();
});

beforeEach(() => {
  hub.reset();
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  tmp = normalizePath(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-hub-install-'))));
  project = path.posix.join(tmp, 'project');
  library = path.posix.join(tmp, 'library');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'fluidcad.json'), JSON.stringify({ engine: ENGINE }, null, 2) + '\n');
  fs.writeFileSync(path.join(project, 'init.js'), '');
  process.env.FLUIDCAD_PACKAGES = library;
  process.env.FLUIDCAD_HOME = path.join(tmp, 'fluidcad-home');
  process.env.HOME = path.join(tmp, 'home');
  process.env.XDG_CONFIG_HOME = path.join(tmp, 'home');
  process.env.APPDATA = path.join(tmp, 'home');
  PackageRoots.forget();
  servers = [];
  installs = [];
});

afterEach(async () => {
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved[key];
    }
  }
  PackageRoots.forget();
  writable(tmp);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('POST /api/hub/install', () => {
  it("installs the hub's latest by name into the library, pins it, answers its manifest and tells the engine", async () => {
    await publish('0.1.0');
    const latest = await publish('0.2.0');
    const base = await serve();
    const res = await install(base, { name: KIT });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      name: KIT,
      version: '0.2.0',
      source: 'hub',
      status: 'installed',
      target: 'library',
      integrity: latest.integrity,
      pin: 'pinned',
      upgradedFrom: null,
      notes: [],
      manifest: { name: KIT, version: '0.2.0', features: [{ id: 'standoff', exportName: 'standoff' }] },
    });
    expect(res.body.directory).toBe(path.posix.join(library, '@acme', 'kit', '0.2.0'));
    expect(fs.existsSync(path.join(library, '@acme', 'kit', '0.2.0', 'manifest.json'))).toBe(true);
    expect(pins()).toEqual({ [KIT]: { version: '0.2.0', integrity: latest.integrity } });
    expect(scratch(library)).toEqual([]);
    expect(installs).toHaveLength(1);
    expect(installs[0]).toMatchObject({ name: KIT, version: '0.2.0', pin: 'pinned' });
  });

  it('uses an installed copy without a download: an exact version never asks the hub, a name alone only asks which version', async () => {
    const version = await publish('0.2.0');
    const base = await serve();
    expect((await install(base, { name: KIT, version: '0.2.0' })).body).toMatchObject({ source: 'hub', status: 'installed', pin: 'pinned' });
    expect(hub.downloadsOf(KIT, '0.2.0')).toHaveLength(1);

    const requests = hub.requests.length;
    const exact = await install(base, { name: KIT, version: '0.2.0' });
    expect(exact.body).toMatchObject({ source: 'installed', status: 'unchanged', pin: 'unchanged', target: 'library', integrity: version.integrity });
    expect(exact.body.manifest).toMatchObject({ name: KIT, version: '0.2.0' });
    expect(hub.requests.length).toBe(requests);

    // The project pins it now, so a name alone means that version: still no hub.
    expect((await install(base, { name: KIT })).body).toMatchObject({ source: 'installed', version: '0.2.0', pin: 'unchanged' });
    expect(hub.requests.length).toBe(requests);
    expect(hub.downloadsOf(KIT, '0.2.0')).toHaveLength(1);
  });

  it('pins a copy the library already holds into a project that does not use it yet, with the hub confirming its contents', async () => {
    const version = await publish('0.2.0');
    await LibrarySeed.install(await kitArchive('0.2.0'));
    const base = await serve();
    const res = await install(base, { name: KIT });
    expect(res.body).toMatchObject({ source: 'installed', status: 'unchanged', pin: 'pinned', integrity: version.integrity });
    expect(hub.downloads).toHaveLength(0);
    expect(pins()).toEqual({ [KIT]: { version: '0.2.0', integrity: version.integrity } });
  });

  it("installs into the project's packages/ folder for the project target, and copies a library copy in", async () => {
    await publish('0.1.0');
    await publish('0.2.0');
    const base = await serve();
    const downloaded = await install(base, { name: KIT, version: '0.1.0', target: 'project' });
    expect(downloaded.body).toMatchObject({ source: 'hub', status: 'installed', target: 'project', pin: 'pinned' });
    expect(fs.existsSync(path.join(project, 'packages', '@acme', 'kit', '0.1.0', 'manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(library, '@acme', 'kit', '0.1.0'))).toBe(false);
    expect(scratch(path.join(project, 'packages'))).toEqual([]);

    await LibrarySeed.install(await kitArchive('0.2.0'));
    const copied = await install(base, { name: KIT, version: '0.2.0', target: 'project', upgrade: true });
    expect(copied.body).toMatchObject({ source: 'installed', status: 'installed', target: 'project', pin: 'pinned', upgradedFrom: '0.1.0' });
    expect(fs.existsSync(path.join(project, 'packages', '@acme', 'kit', '0.2.0', 'manifest.json'))).toBe(true);
    expect(hub.downloadsOf(KIT, '0.2.0')).toHaveLength(0);
  });

  it('installs into the library and pins nothing without a project; a project target is refused', async () => {
    await publish('0.2.0');
    const base = await serve({ workspacePath: '' });
    const res = await install(base, { name: KIT });
    expect(res.body).toMatchObject({ source: 'hub', status: 'installed', target: 'library', pin: null });
    const again = await install(base, { name: KIT });
    expect(again.body).toMatchObject({ source: 'installed', status: 'unchanged', pin: null });
    const refused = await install(base, { name: KIT, target: 'project' });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe('no-project');
  });

  it("never moves the project's pin by itself: another version is refused before any download, upgrade moves it up, never down", async () => {
    await publish('0.1.0');
    const newer = await publish('0.2.0');
    await LibrarySeed.install(await kitArchive('0.1.0'), { project, pin: true });
    const base = await serve();

    const refused = await install(base, { name: KIT, version: '0.2.0' });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('version-change');
    expect(hub.downloads).toHaveLength(0);
    expect(pins()?.[KIT]?.version).toBe('0.1.0');
    expect(installs).toEqual([]);

    // A name alone with upgrade means the hub's latest, not the pinned version.
    const upgraded = await install(base, { name: KIT, upgrade: true });
    expect(upgraded.status).toBe(200);
    expect(upgraded.body).toMatchObject({ version: '0.2.0', source: 'hub', status: 'installed', pin: 'pinned', upgradedFrom: '0.1.0' });
    expect(pins()).toEqual({ [KIT]: { version: '0.2.0', integrity: newer.integrity } });

    const down = await install(base, { name: KIT, version: '0.1.0', upgrade: true });
    expect(down.status).toBe(409);
    expect(down.body.code).toBe('version-change');
    expect(pins()?.[KIT]?.version).toBe('0.2.0');
  });

  it('refuses the same version installed with other contents, with no replace, and leaves no scratch behind', async () => {
    await publish('0.2.0');
    await LibrarySeed.install(await kitArchive('0.2.0', {}, { 'standoff.feature.js': 'export const standoff = () => "mine";\n' }));
    const base = await serve();
    const res = await install(base, { name: KIT });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('conflict');
    expect(hub.downloadsOf(KIT, '0.2.0')).toHaveLength(1);
    expect(scratch(library)).toEqual([]);
    expect(pins()).toBeNull();
    expect(installs).toEqual([]);
    // `replace` isn't part of the route: sent anyway, it changes nothing.
    expect((await install(base, { name: KIT, replace: true })).status).toBe(409);
  });

  it('refuses a download whose contents are not what the hub lists, installing nothing', async () => {
    await publish('0.2.0');
    hub.nextDownload = { integrity: 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' };
    const base = await serve();
    const res = await install(base, { name: KIT });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('integrity-mismatch');
    expect(fs.existsSync(path.join(library, '@acme', 'kit'))).toBe(false);
    expect(scratch(library)).toEqual([]);
    expect(pins()).toBeNull();
  });

  it('passes the hub\'s notes and the archive\'s warnings on: an older version picked for this engine', async () => {
    await publish('0.1.0');
    await publish('0.2.0', { minEngine: '0.0.99' });
    const base = await serve();
    const res = await install(base, { name: KIT });
    expect(res.body.version).toBe('0.1.0');
    expect(res.body.notes).toEqual([
      `The latest @acme/kit, 0.2.0, needs FluidCAD 0.0.99 or newer; this FluidCAD is ${ENGINE}, so this installs 0.1.0, the newest version it runs.`,
    ]);
  });

  it('refuses a name without its publisher, a name that is no package name, a bad body, a form post and an unknown package', async () => {
    const base = await serve();
    const bare = await install(base, { name: 'kit' });
    expect(bare.status).toBe(400);
    expect(bare.body.code).toBe('no-publisher');
    const path_ = await install(base, { name: './kit.fluidpkg' });
    expect(path_.status).toBe(400);
    expect(path_.body.code).toBe('bad-request');
    expect((await install(base, { name: KIT, version: 'latest' })).status).toBe(400);
    expect((await install(base, { name: 7 })).status).toBe(400);
    expect((await install(base, { name: KIT, target: 'desktop' })).status).toBe(400);
    expect((await install(base, { name: KIT, upgrade: 'yes' })).status).toBe(400);
    const form = await call(`${base}/hub/install`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ name: KIT }) });
    expect(form.status).toBe(415);
    const missing = await install(base, { name: '@acme/nothing' });
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('not-found');
    expect(hub.downloads).toHaveLength(0);
    expect(installs).toEqual([]);
  });

  it('with the hub unreachable: nothing to install is 503, a library copy is used with a note saying so', async () => {
    const offline = await serve({ hubUrl: await closedPort() });
    const nothing = await install(offline, { name: KIT });
    expect(nothing.status).toBe(503);
    expect(nothing.body.code).toBe('hub-unreachable');

    await LibrarySeed.install(await kitArchive('0.1.0'));
    const local = await install(offline, { name: KIT });
    expect(local.status).toBe(200);
    expect(local.body).toMatchObject({ source: 'installed', version: '0.1.0', pin: 'pinned' });
    expect(local.body.notes).toHaveLength(1);
    expect(local.body.notes[0]).toContain("Couldn't reach");
    expect(pins()?.[KIT]?.version).toBe('0.1.0');
  });
});

describe('GET /api/hub/packages/@scope/name/versions/<version>', () => {
  it("lists the version's doc pages and files, for an agent to read", async () => {
    await publish('0.2.0');
    const base = await serve();
    const res = await call(`${base}/hub/packages/@acme/kit/versions/0.2.0`);
    expect(res.status).toBe(200);
    expect(res.body.docs).toEqual(['docs/standoff.md']);
    expect(res.body.files.map((file: { path: string }) => file.path)).toEqual([
      'README.md', 'docs/standoff.md', 'fluidcad.json', 'index.js', 'manifest.json', 'standoff.feature.js',
    ]);
    expect(res.body.files[1]).toEqual({ path: 'docs/standoff.md', size: PAGE.length });
  });
});

describe('GET /api/packages/file/@scope/name/<version>/<path>', () => {
  it("reads an installed package's doc page, source and manifest: the library's, and the project copy first", async () => {
    await LibrarySeed.install(await kitArchive('0.2.0'));
    const base = await serve();
    const page = await call(`${base}/packages/file/@acme/kit/0.2.0/docs/standoff.md`);
    expect(page.status).toBe(200);
    expect(page.body).toEqual({ name: KIT, version: '0.2.0', path: 'docs/standoff.md', target: 'library', content: PAGE });
    expect((await call(`${base}/packages/file/@acme/kit/0.2.0/standoff.feature.js`)).body.content).toContain("'0.2.0'");
    expect(JSON.parse((await call(`${base}/packages/file/@acme/kit/0.2.0/manifest.json`)).body.content).name).toBe(KIT);

    await LibrarySeed.install(await kitArchive('0.2.0'), { target: 'project', project });
    expect((await call(`${base}/packages/file/@acme/kit/0.2.0/README.md`)).body.target).toBe('project');
  });

  it('refuses a package that is not installed, a file it does not list, a path that climbs out, and a file that is not text', async () => {
    await LibrarySeed.install(await kitArchive('0.2.0', {}, { 'standoff.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 13]) }));
    fs.writeFileSync(path.join(tmp, 'secret.txt'), 'secret');
    const base = await serve();
    const absent = await call(`${base}/packages/file/@acme/kit/0.9.0/README.md`);
    expect(absent.status).toBe(404);
    expect(absent.body.code).toBe('not-installed');
    const unlisted = await call(`${base}/packages/file/@acme/kit/0.2.0/docs/nothing.md`);
    expect(unlisted.status).toBe(404);
    expect(unlisted.body.code).toBe('not-found');
    // `..` never reaches the disk, however it is spelled (a client that doesn't fold it sends it as is).
    const climbing = await fetch(`${base}/packages/file/@acme/kit/0.2.0/docs/..%2f..%2f..%2f..%2fsecret.txt`);
    expect([400, 404]).toContain(climbing.status);
    expect(await climbing.text()).not.toContain('"content"');
    const binary = await call(`${base}/packages/file/@acme/kit/0.2.0/standoff.png`);
    expect(binary.status).toBe(415);
    expect(binary.body.code).toBe('not-text');
    expect((await call(`${base}/packages/file/acme/kit/0.2.0/README.md`)).status).toBe(400);
  });
});
