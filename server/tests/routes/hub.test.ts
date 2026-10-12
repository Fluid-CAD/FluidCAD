import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import express from 'express';
import fs from 'fs';
import http from 'http';
import net from 'net';
import os from 'os';
import path from 'path';
import { createHubRouter } from '../../src/routes/hub.ts';
import { createPackagesRouter } from '../../src/routes/packages.ts';
import { HubCredentials } from '../../src/hub/hub-credentials.ts';
import { HubFileCache } from '../../src/hub/hub-file-cache.ts';
import { HubTransport } from '../../src/hub/hub-transport.ts';
import { PackageArchive } from '../../src/packages/package-archive.ts';
import { PackageRoots } from '../../src/packages/package-roots.ts';
import { normalizePath } from '../../src/normalize-path.ts';
import { readProjectConfig } from '../../src/project-config.ts';
import { ArchiveFixture } from '../packages/archive-fixture.ts';
import { LibrarySeed } from '../packages/library-seed.ts';
import { FakeHub } from '../fixtures/fake-hub.ts';
import { SearchFixture } from '../fixtures/search-fixture.ts';

/**
 * The hub bridge's routes (hub-plan Stage H10) against the in-process
 * FakeHub: status, search with the local marks and the proxy paths, the
 * detail, the files and screenshots through the disk cache, the inspect →
 * install round trip with the existing install route, and the
 * `hub-unreachable` mapping. FLUIDCAD_HOME (the cache and the credentials),
 * FLUIDCAD_PACKAGES and HOME are temp folders; the hub URL reaches the
 * router through its `env`, so nothing here can reach a real hub.
 */

const ENGINE = ArchiveFixture.ENGINE;
const KIT = '@acme/kit';
const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><circle cx="4" cy="4" r="3"/></svg>';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const ENV_KEYS = ['FLUIDCAD_PACKAGES', 'FLUIDCAD_HOME', 'HOME', 'XDG_CONFIG_HOME', 'APPDATA'] as const;

let hub: FakeHub;
let saved: Record<string, string | undefined>;
let tmp: string;
let project: string;
let library: string;
let servers: http.Server[];

/** `@acme/kit` at `version`, with a feature icon; each version's feature module differs. */
async function kitArchive(version: string, manifest: Record<string, unknown> = {}): Promise<Buffer> {
  const files = {
    ...ArchiveFixture.defaultFiles(),
    'standoff.feature.js': `export const standoff = () => '${version}';\n`,
    'standoff.svg': ICON,
  };
  return ArchiveFixture.zip({
    version,
    files,
    manifest: {
      features: [{ id: 'standoff', exportName: 'standoff', module: 'standoff.feature.js', meta: { label: 'Standoff', icon: './standoff.svg' } }],
      ...manifest,
    },
  });
}

async function publish(version: string, row: Parameters<FakeHub['addArchive']>[1] = {}, manifest: Record<string, unknown> = {}) {
  return hub.addArchive(await kitArchive(version, manifest), row);
}

async function serve(options: { workspacePath?: string; env?: Record<string, string>; hubUrl?: string } = {}): Promise<string> {
  const workspacePath = options.workspacePath ?? project;
  const app = express();
  app.use(express.json());
  app.use('/api', createPackagesRouter({ workspacePath }));
  app.use('/api', createHubRouter({
    workspacePath,
    engineVersion: ENGINE,
    sdkVersion: 1,
    env: { FLUIDCAD_HUB_URL: options.hubUrl ?? hub.origin, ...options.env },
    transport: new HubTransport({ version: ENGINE, client: 'app', retryDelayMs: 1 }),
  }));
  const server = http.createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return `http://127.0.0.1:${(server.address() as net.AddressInfo).port}/api`;
}

async function call(url: string, init: RequestInit = {}): Promise<{ status: number; body: any; headers: Headers }> {
  const res = await fetch(url, init);
  return { status: res.status, body: await res.json(), headers: res.headers };
}

function postJson(url: string, body: unknown) {
  return call(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

/** A local port nothing listens on: an offline hub. */
async function closedPort(): Promise<string> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

function cacheEntries(): string[] {
  try {
    return fs.readdirSync(path.join(tmp, 'fluidcad-home', 'cache', 'hub')).sort();
  } catch {
    return [];
  }
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
  tmp = normalizePath(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-hub-routes-'))));
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

describe('GET /api/hub/status', () => {
  it('names the hub, says it answers, and that nobody is signed in', async () => {
    const base = await serve();
    const status = await call(`${base}/hub/status`);
    expect(status.status).toBe(200);
    expect(status.body).toEqual({ hubUrl: hub.origin, reachable: true, signedIn: null, engine: ENGINE, sdk: 1 });
    expect(status.headers.get('cache-control')).toBe('no-store');
  });

  it("reads the stored credential's handle without asking the hub who it is", async () => {
    HubCredentials.write(hub.origin, { token: hub.issueToken().token, tokenId: null, handle: 'acme', email: 'acme@example.com' });
    const base = await serve();
    expect((await call(`${base}/hub/status`)).body.signedIn).toEqual({ handle: 'acme' });
    expect(hub.requestsTo('/api/v1/me')).toHaveLength(0);
  });

  it('asks GET /me for a FLUIDCAD_HUB_TOKEN, and counts a refused one as signed out', async () => {
    const base = await serve({ env: { FLUIDCAD_HUB_TOKEN: hub.issueToken().token } });
    expect((await call(`${base}/hub/status`)).body.signedIn).toEqual({ handle: 'acme' });
    const refused = await serve({ env: { FLUIDCAD_HUB_TOKEN: 'fch_revoked' } });
    expect((await call(`${refused}/hub/status`)).body.signedIn).toBeNull();
  });

  it('answers 200 with reachable false when the hub is offline, still naming the stored handle', async () => {
    const offline = await closedPort();
    const base = await serve({ hubUrl: offline });
    expect((await call(`${base}/hub/status`)).body).toMatchObject({ hubUrl: offline, reachable: false, signedIn: null });
    HubCredentials.write(offline, { token: 'fch_x', tokenId: null, handle: 'acme', email: null });
    const status = await call(`${base}/hub/status`);
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ hubUrl: offline, reachable: false, signedIn: { handle: 'acme' } });
  });
});

describe('GET /api/hub/search', () => {
  it("forwards the panel's parameters as the hub names them, as repeated keys, with this engine and every package", async () => {
    const base = await serve();
    const query = 'q=%40acme+standoff&contents=features&contents=parts&keyword=pcb&keyword=fasteners&units=metric&license=MIT&license=Apache-2.0&page=2&limit=5'
      + '&engine=9.9.9&sdk=7&compatible=true&includeIncompatible=0&avatar=1';
    const res = await call(`${base}/hub/search?${query}`);
    expect(res.status).toBe(200);
    const sent = hub.searchQueries()[0];
    expect(sent.get('q')).toBe('@acme standoff');
    expect(sent.getAll('contents')).toEqual(['features', 'parts']);
    expect(sent.getAll('keyword')).toEqual(['pcb', 'fasteners']);
    expect(sent.getAll('units')).toEqual(['metric']);
    expect(sent.getAll('license')).toEqual(['MIT', 'Apache-2.0']);
    expect(sent.get('page')).toBe('2');
    expect(sent.get('limit')).toBe('5');
    // The engine's own, whatever the page sent; every package (H11 decision 2); no sort or order: the hub picks.
    expect(sent.getAll('engine')).toEqual([ENGINE]);
    expect(sent.getAll('sdk')).toEqual(['1']);
    expect(sent.has('compatible')).toBe(false);
    expect(sent.has('includeIncompatible')).toBe(false);
    expect(sent.has('sort')).toBe(false);
    expect(sent.has('order')).toBe(false);
    expect(sent.has('avatar')).toBe(false);
  });

  it('sends the sort and its direction when they are asked for', async () => {
    const base = await serve();
    await call(`${base}/hub/search?sort=newest&order=asc`);
    const sent = hub.searchQueries()[0];
    expect(sent.has('compatible')).toBe(false);
    expect(sent.get('sort')).toBe('newest');
    expect(sent.get('order')).toBe('asc');
    expect(sent.get('engine')).toBe(ENGINE);
    expect(sent.get('sdk')).toBe('1');
  });

  it("rewrites icons and card images to the engine's proxy paths, drops avatars, and changes nothing else", async () => {
    const card = hub.addMedia(KIT, PNG);
    const answer = SearchFixture.answer([
      SearchFixture.row({ origin: hub.origin, cardId: card, chips: ['Standoff', 'Boss'], moreFeatures: 2 }),
      { ...SearchFixture.row({ origin: hub.origin, fullName: '@bea/other', compatible: false, sdkVersion: 2 }), cardImageUrl: 'https://elsewhere.example.com/x.png' },
    ], { total: 1234, capped: true });
    hub.searchAnswer = answer;
    const base = await serve();
    const res = await call(`${base}/hub/search?q=standoff`);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const [kit, other] = res.body.results;
    expect(kit.cardImageUrl).toBe(`api/hub/media/@acme/kit/${card}`);
    expect(kit.features.map((chip: any) => chip.iconUrl)).toEqual(['api/hub/files/@acme/kit/0.2.0/standoff.svg', 'api/hub/files/@acme/kit/0.2.0/boss.svg']);
    expect(kit.publisher).toEqual({ handle: 'acme' });
    expect(JSON.stringify(res.body)).not.toContain('avatar');
    expect(other.cardImageUrl).toBeNull();
    expect(res.body).toMatchObject({ request: answer.request, total: 1234, capped: true, page: 1, limit: 20, facets: answer.facets });
    expect(kit).toMatchObject({ fullName: KIT, version: '0.2.0', moreFeatures: 2, likes: 0, license: 'MIT', minEngine: '0.0.46', sdkVersion: 1, compatible: true });
    // The row's feature SDK passes through, so the UI can say why it is incompatible.
    expect(other).toMatchObject({ minEngine: '0.0.46', sdkVersion: 2, compatible: false });
  });

  it("marks what the project's copy and the library hold, the pin, and an update above the pin", async () => {
    await LibrarySeed.install(await kitArchive('0.1.0'), { target: 'project', project });
    await LibrarySeed.install(await kitArchive('0.1.5'));
    hub.searchAnswer = SearchFixture.answer([
      SearchFixture.row({ origin: hub.origin, version: '0.2.0' }),
      SearchFixture.row({ origin: hub.origin, fullName: '@acme/gears', version: '1.0.0' }),
    ]);
    const base = await serve();
    const [kit, gears] = (await call(`${base}/hub/search`)).body.results;
    expect(kit.local).toEqual({ installed: ['0.1.0', '0.1.5'], pinned: '0.1.0', updateAvailable: '0.2.0' });
    expect(gears.local).toEqual({ installed: [], pinned: null, updateAvailable: null });
  });

  it('offers no update a row this FluidCAD cannot run, and outside a project compares with the newest installed version', async () => {
    await LibrarySeed.install(await kitArchive('0.1.0'));
    await LibrarySeed.install(await kitArchive('0.1.5'));
    hub.searchAnswer = SearchFixture.answer([SearchFixture.row({ origin: hub.origin, version: '0.3.0', compatible: false, minEngine: '0.0.99' })]);
    const inProject = await serve();
    expect((await call(`${inProject}/hub/search`)).body.results[0].local).toEqual({ installed: ['0.1.0', '0.1.5'], pinned: null, updateAvailable: null });

    hub.searchAnswer = SearchFixture.answer([SearchFixture.row({ origin: hub.origin, version: '0.3.0' })]);
    const outside = await serve({ workspacePath: '' });
    expect((await call(`${outside}/hub/search`)).body.results[0].local).toEqual({ installed: ['0.1.0', '0.1.5'], pinned: null, updateAvailable: '0.3.0' });
  });

  it("passes the hub's 400 on with its code and a sentence naming the refused field, and its 429", async () => {
    hub.nextSearch = {
      status: 400,
      code: 'bad-request',
      message: 'The request is not valid.',
      details: { issues: [{ path: ['license', 0], code: 'custom', message: "Use one of the hub's licenses: MIT, Apache-2.0." }] },
    };
    const base = await serve();
    const refused = await call(`${base}/hub/search?license=WTFPL`);
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe('bad-request');
    expect(refused.body.error).toBe("The request is not valid: license: Use one of the hub's licenses: MIT, Apache-2.0.");
    expect(refused.body.details.issues).toHaveLength(1);

    hub.nextSearch = { status: 429, code: 'rate-limited', message: 'Too many searches from this address.' };
    const limited = await call(`${base}/hub/search?q=x`);
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ error: 'Too many searches from this address.', code: 'rate-limited' });
  });

  it('answers 503 hub-unreachable when the hub is offline or fails on its side', async () => {
    const offline = await closedPort();
    const base = await serve({ hubUrl: offline });
    const res = await call(`${base}/hub/search?q=standoff`);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('hub-unreachable');
    expect(res.body.error).toContain(`Couldn't reach ${offline}`);
    expect(res.body.details).toEqual({ hub: offline, cause: 'network' });

    hub.failNext('/api/v1/search', 500, 2);
    const failing = await serve();
    const failed = await call(`${failing}/hub/search`);
    expect(failed.status).toBe(503);
    expect(failed.body.code).toBe('hub-unreachable');
  });
});

describe('GET /api/hub/packages/@scope/name', () => {
  it('answers the detail with the local marks against the pin, and its images on the proxy paths', async () => {
    await publish('0.1.0');
    await publish('0.2.0');
    const shot = hub.addMedia(KIT, PNG);
    await LibrarySeed.install(await kitArchive('0.1.0'), { project, pin: true });
    const base = await serve();
    const res = await call(`${base}/hub/packages/@acme/kit`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(hub.requestsTo(`/api/v1/packages/${KIT}`)[0].query).toBe(`?engine=${ENGINE}&sdk=1`);
    expect(res.body).toMatchObject({ name: KIT, latestVersion: '0.2.0', compatibility: { latestCompatible: true, newestCompatible: '0.2.0' } });
    expect(res.body.local).toEqual({ installed: ['0.1.0'], pinned: '0.1.0', updateAvailable: '0.2.0' });
    expect(res.body.latest.features).toEqual([expect.objectContaining({ id: 'standoff', icon: 'standoff.svg', iconUrl: 'api/hub/files/@acme/kit/0.2.0/standoff.svg' })]);
    expect(res.body.listing.media).toEqual([expect.objectContaining({ id: shot, url: `api/hub/media/@acme/kit/${shot}` })]);
  });

  it('offers the newest version this engine runs, not a latest it cannot', async () => {
    await publish('0.1.0');
    await publish('0.2.0', {}, { minEngine: '0.0.99' });
    await LibrarySeed.install(await kitArchive('0.1.0'), { project, pin: true });
    const base = await serve();
    expect((await call(`${base}/hub/packages/@acme/kit`)).body.local.updateAvailable).toBeNull();
  });

  it('refuses an unknown package (404), a bad name (400), and maps an offline hub to 503', async () => {
    const base = await serve();
    const missing = await call(`${base}/hub/packages/@acme/nothing`);
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: `@acme/nothing isn't on ${hub.origin}.`, code: 'not-found' });
    expect((await call(`${base}/hub/packages/acme/kit`)).status).toBe(400);
    const offline = await serve({ hubUrl: await closedPort() });
    expect((await call(`${offline}/hub/packages/@acme/kit`)).body.code).toBe('hub-unreachable');
  });
});

describe('GET /api/hub/packages/@scope/name/versions/<version>', () => {
  /** `@acme/kit` with a feature whose metadata declares every kind of image, and a README. */
  async function richArchive(version: string, extra: Record<string, string> = {}): Promise<Buffer> {
    const meta = {
      id: 'fastener',
      label: 'Fastener hole',
      icon: './fastener/icon.svg',
      params: {
        size: { type: 'select', label: 'Screw', options: [{ label: 'M3', value: 'm3', image: './fastener/m3.svg' }, { label: 'M4', value: 'm4', image: '../escape.svg' }] },
        depth: { type: 'length', label: 'Depth', default: 10, aside: [{ image: './fastener/depth.svg' }] },
      },
      layout: [{ tabs: [{ label: 'Hole', items: ['size', { row: ['depth', { image: './fastener/row.svg' }] }] }] }],
      aside: [{ note: 'Clearance per ISO 273.' }, { image: 'https://elsewhere.example.com/x.svg' }, { divider: true }],
    };
    return ArchiveFixture.zip({
      version,
      files: { ...ArchiveFixture.defaultFiles(), 'features/fastener.feature.js': 'export const fastener = () => null;\n', 'features/fastener/icon.svg': ICON, ...extra },
      manifest: {
        features: [{ id: 'fastener', exportName: 'fastener', module: 'features/fastener.feature.js', meta }],
        parts: [{ exportName: 'plate', module: 'parts/plate.part.js', name: 'Plate', kind: 'part', exportKind: 'value', params: [] }],
      },
    });
  }

  it("answers the version's manifest with every image its features declare on the file proxy, the notes and the README's path", async () => {
    await hub.addArchive(await richArchive('0.2.0', { 'README.md': '# Kit\n' }), { notes: 'Adds the fastener.' });
    const base = await serve();
    const res = await call(`${base}/hub/packages/@acme/kit/versions/0.2.0`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.body).toMatchObject({ name: KIT, version: '0.2.0', status: 'published', access: 'public', notes: 'Adds the fastener.', isLatest: true, sdkVersion: 1 });
    expect(res.body.readmeUrl).toBe('api/hub/files/@acme/kit/0.2.0/README.md');
    const [feature] = res.body.manifest.features;
    expect(feature).toMatchObject({ id: 'fastener', exportName: 'fastener', module: 'features/fastener.feature.js' });
    const file = (rel: string) => `api/hub/files/@acme/kit/0.2.0/${rel}`;
    expect(feature.meta.icon).toBe(file('features/fastener/icon.svg'));
    expect(feature.meta.params.size.options[0].image).toBe(file('features/fastener/m3.svg'));
    // A path out of the module's directory is dropped, not rewritten.
    expect(feature.meta.params.size.options[1]).toEqual({ label: 'M4', value: 'm4' });
    expect(feature.meta.params.depth.aside[0].image).toBe(file('features/fastener/depth.svg'));
    expect(feature.meta.layout[0].tabs[0].items[1].row[1].image).toBe(file('features/fastener/row.svg'));
    // Another origin is no path inside the package either; notes and dividers pass unchanged.
    expect(feature.meta.aside).toEqual([{ note: 'Clearance per ISO 273.' }, {}, { divider: true }]);
    expect(res.body.manifest.parts).toEqual([expect.objectContaining({ exportName: 'plate', kind: 'part', exportKind: 'value' })]);
    // The proxied icon is served from the archive.
    const icon = await fetch(`${base.replace(/\/api$/, '')}/${feature.meta.icon.replace(/^api\//, 'api/')}`);
    expect(icon.status).toBe(200);
  });

  it('answers readmeUrl null without a README, and refuses an unknown version (404), a non-version (400) and an offline hub (503)', async () => {
    await hub.addArchive(await richArchive('0.2.0'));
    const base = await serve();
    expect((await call(`${base}/hub/packages/@acme/kit/versions/0.2.0`)).body.readmeUrl).toBeNull();
    const missing = await call(`${base}/hub/packages/@acme/kit/versions/9.9.9`);
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('not-found');
    expect((await call(`${base}/hub/packages/@acme/kit/versions/latest`)).status).toBe(400);
    const offline = await serve({ hubUrl: await closedPort() });
    const unreachable = await call(`${offline}/hub/packages/@acme/kit/versions/0.2.0`);
    expect(unreachable.status).toBe(503);
    expect(unreachable.body.code).toBe('hub-unreachable');
  });
});

describe('GET /api/hub/files and /api/hub/media (the disk cache)', () => {
  it('serves a published file with its type, then the second read from disk without asking the hub', async () => {
    await publish('0.2.0');
    const base = await serve();
    const url = `${base}/hub/files/@acme/kit/0.2.0/standoff.svg`;
    const first = await fetch(url);
    expect(first.status).toBe(200);
    expect(first.headers.get('content-type')).toBe('image/svg+xml');
    expect(first.headers.get('content-security-policy')).toBe("default-src 'none'; style-src 'unsafe-inline'; sandbox");
    expect(first.headers.get('x-content-type-options')).toBe('nosniff');
    expect(first.headers.get('x-fluidcad-hub-cache')).toBe('miss');
    expect(await first.text()).toBe(ICON);
    expect(cacheEntries()).toHaveLength(2);

    const asked = hub.requests.length;
    const second = await fetch(url);
    expect(second.headers.get('x-fluidcad-hub-cache')).toBe('hit');
    expect(second.headers.get('content-type')).toBe('image/svg+xml');
    expect(await second.text()).toBe(ICON);
    expect(hub.requests.length).toBe(asked);

    // The hub gone: the cached file still serves; one never read is 503.
    const offline = await serve({ hubUrl: hub.origin });
    await hub.stop();
    try {
      expect((await fetch(`${offline}/hub/files/@acme/kit/0.2.0/standoff.svg`)).status).toBe(200);
      const uncached = await call(`${offline}/hub/files/@acme/kit/0.2.0/index.js`);
      expect(uncached.status).toBe(503);
      expect(uncached.body.code).toBe('hub-unreachable');
    } finally {
      hub = await FakeHub.start();
    }
  });

  it("keeps nothing the hub doesn't call immutable: an owner's unpublished version is asked for each time", async () => {
    await publish('0.3.0', { status: 'in_review', publishedAt: null });
    HubCredentials.write(hub.origin, { token: hub.issueToken().token, tokenId: null, handle: 'acme', email: null });
    const base = await serve();
    const url = `${base}/hub/files/@acme/kit/0.3.0/standoff.svg`;
    const first = await fetch(url);
    expect(first.status).toBe(200);
    expect(first.headers.get('x-fluidcad-hub-cache')).toBe('none');
    await fetch(url);
    expect(hub.requests.filter((r) => r.path === '/api/v1/packages/@acme/kit/versions/0.3.0/files/standoff.svg')).toHaveLength(2);
    expect(cacheEntries()).toEqual([]);
  });

  it('refuses a path that climbs out of the archive and a version that is not one, asking the hub nothing', async () => {
    const base = await serve();
    // A URL parser folds `..` (and `%2E%2E`) segments before sending, so a
    // climb can only arrive with its slashes encoded inside one segment.
    const climbing = await call(`${base}/hub/files/@acme/kit/0.2.0/..%2F..%2F..%2Fme`);
    expect(climbing.status).toBe(400);
    expect(climbing.body.code).toBe('bad-request');
    expect((await call(`${base}/hub/files/@acme/kit/latest/standoff.svg`)).status).toBe(400);
    expect((await call(`${base}/hub/media/@acme/kit/not%20an%20id`)).status).toBe(400);
    expect(hub.requests).toHaveLength(0);
  });

  it("passes the hub's 404 for a file the archive doesn't hold", async () => {
    await publish('0.2.0');
    const base = await serve();
    const res = await call(`${base}/hub/files/@acme/kit/0.2.0/nope.svg`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('not-found');
  });

  it('caches a card image by its id', async () => {
    await publish('0.2.0');
    const id = hub.addMedia(KIT, PNG);
    const base = await serve();
    const first = await fetch(`${base}/hub/media/@acme/kit/${id}`);
    expect(first.headers.get('content-type')).toBe('image/png');
    expect(first.headers.get('x-fluidcad-hub-cache')).toBe('miss');
    expect(Buffer.from(await first.arrayBuffer()).equals(PNG)).toBe(true);
    const second = await fetch(`${base}/hub/media/@acme/kit/${id}`);
    expect(second.headers.get('x-fluidcad-hub-cache')).toBe('hit');
    expect(Buffer.from(await second.arrayBuffer()).equals(PNG)).toBe(true);
    expect(hub.requestsTo(`/api/v1/packages/@acme/kit/media/${id}`)).toHaveLength(1);
    const key = HubFileCache.keyOf(`${hub.origin}/api/v1/packages/@acme/kit/media/${id}`);
    expect(cacheEntries()).toEqual([`${key}.bin`, `${key}.json`]);
  });
});

describe('POST /api/hub/inspect → POST /api/packages/install', () => {
  it('downloads, verifies and inspects; the install route takes its token; the search then marks it', async () => {
    await publish('0.1.0');
    const latest = await publish('0.2.0');
    const base = await serve();
    const inspected = await postJson(`${base}/hub/inspect`, { name: KIT, version: '0.2.0', target: 'library' });
    expect(inspected.status).toBe(200);
    expect(inspected.body).toMatchObject({
      manifest: { name: KIT, version: '0.2.0' },
      integrity: latest.integrity,
      warnings: [],
      defaultTarget: 'library',
      notes: [],
      source: { hub: hub.origin, status: 'published', access: 'public' },
    });
    expect(typeof inspected.body.token).toBe('string');
    expect(inspected.body.bytes).toBeGreaterThan(0);
    expect(hub.downloadsOf(KIT, '0.2.0')).toHaveLength(1);
    // Inspected, not installed.
    expect(fs.existsSync(path.join(library, '@acme', 'kit', '0.2.0'))).toBe(false);

    const icon = await fetch(`${base}/packages/inspected-icon?token=${inspected.body.token}&id=standoff`);
    expect(icon.status).toBe(200);

    const installed = await postJson(`${base}/packages/install`, { token: inspected.body.token, target: 'library', pin: true });
    expect(installed.status).toBe(200);
    expect(installed.body).toMatchObject({ name: KIT, version: '0.2.0', status: 'installed', pin: 'pinned', integrity: latest.integrity });
    expect(readProjectConfig(project).dependencies).toEqual({ [KIT]: { version: '0.2.0', integrity: latest.integrity } });

    hub.searchAnswer = SearchFixture.answer([SearchFixture.row({ origin: hub.origin, version: '0.2.0' })]);
    expect((await call(`${base}/hub/search`)).body.results[0].local).toEqual({ installed: ['0.2.0'], pinned: '0.2.0', updateAvailable: null });
  });

  it("takes the latest this engine runs without a version, with the resolution's note, and the setting's target", async () => {
    await publish('0.1.0');
    await publish('0.2.0', {}, { minEngine: '0.0.99' });
    const base = await serve();
    const inspected = await postJson(`${base}/hub/inspect`, { name: KIT });
    expect(inspected.status).toBe(200);
    expect(inspected.body.manifest.version).toBe('0.1.0');
    expect(inspected.body.defaultTarget).toBe('library');
    expect(inspected.body.notes).toEqual([
      'The latest @acme/kit, 0.2.0, needs FluidCAD 0.0.99 or newer; this FluidCAD is 0.0.46, so this installs 0.1.0, the newest version it runs.',
    ]);
    PackageArchive.discard(inspected.body.token);
  });

  it("inspects for the project when asked (the consent dialog's Replace), in the project's scratch", async () => {
    await publish('0.2.0');
    const base = await serve();
    const inspected = await postJson(`${base}/hub/inspect`, { name: KIT, version: '0.2.0', target: 'project' });
    expect(inspected.body.defaultTarget).toBe('project');
    expect(fs.readdirSync(path.join(project, 'packages', '.tmp'))).toHaveLength(1);
    const installed = await postJson(`${base}/packages/install`, { token: inspected.body.token, target: 'project' });
    expect(installed.body).toMatchObject({ target: 'project', status: 'installed', pin: 'pinned' });
  });

  it("checks the project's pin before downloading: another integrity is refused with nothing downloaded", async () => {
    await publish('0.2.0');
    const pin = { version: '0.2.0', integrity: 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' };
    fs.writeFileSync(path.join(project, 'fluidcad.json'), JSON.stringify({ engine: ENGINE, dependencies: { [KIT]: pin } }, null, 2));
    const base = await serve();
    const refused = await postJson(`${base}/hub/inspect`, { name: KIT, version: '0.2.0' });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('integrity-mismatch');
    expect(hub.downloads).toHaveLength(0);
  });

  it("moves the project's pin up with upgrade (the panel's Upgrade to X), never without it, and never down", async () => {
    const older = await publish('0.1.0');
    const newer = await publish('0.2.0');
    await LibrarySeed.install(await kitArchive('0.1.0'), { project, pin: true });
    const base = await serve();
    const first = await postJson(`${base}/hub/inspect`, { name: KIT, version: '0.2.0', target: 'library' });
    const refused = await postJson(`${base}/packages/install`, { token: first.body.token, target: 'library', pin: true });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('version-change');
    expect(readProjectConfig(project).dependencies?.[KIT]?.version).toBe('0.1.0');
    expect(fs.existsSync(path.join(library, '@acme', 'kit', '0.2.0'))).toBe(false);

    const again = await postJson(`${base}/hub/inspect`, { name: KIT, version: '0.2.0', target: 'library' });
    const upgraded = await postJson(`${base}/packages/install`, { token: again.body.token, target: 'library', pin: true, upgrade: true });
    expect(upgraded.status).toBe(200);
    expect(upgraded.body).toMatchObject({ version: '0.2.0', status: 'installed', pin: 'pinned' });
    expect(readProjectConfig(project).dependencies).toEqual({ [KIT]: { version: '0.2.0', integrity: newer.integrity } });

    const down = await postJson(`${base}/hub/inspect`, { name: KIT, version: '0.1.0', target: 'library' });
    const downgrade = await postJson(`${base}/packages/install`, { token: down.body.token, target: 'library', pin: true, upgrade: true });
    expect(downgrade.status).toBe(409);
    expect(downgrade.body.code).toBe('version-change');
    expect(readProjectConfig(project).dependencies?.[KIT]).toEqual({ version: '0.2.0', integrity: newer.integrity });
    expect(older.integrity).not.toBe(newer.integrity);
  });

  it('refuses an unknown package (404), a project target without a project (400), a bad body (400), and an offline hub (503)', async () => {
    const base = await serve();
    const missing = await postJson(`${base}/hub/inspect`, { name: '@acme/nothing', version: '1.0.0' });
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('not-found');
    const noProject = await serve({ workspacePath: '' });
    const target = await postJson(`${noProject}/hub/inspect`, { name: KIT, version: '0.2.0', target: 'project' });
    expect(target.status).toBe(400);
    expect(target.body.code).toBe('no-project');
    expect((await postJson(`${base}/hub/inspect`, { name: 7 })).status).toBe(400);
    const offline = await serve({ hubUrl: await closedPort() });
    const unreachable = await postJson(`${offline}/hub/inspect`, { name: KIT, version: '0.2.0' });
    expect(unreachable.status).toBe(503);
    expect(unreachable.body.code).toBe('hub-unreachable');
  });
});
