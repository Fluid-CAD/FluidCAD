import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import express from 'express';
import fs from 'fs';
import http from 'http';
import net from 'net';
import os from 'os';
import path from 'path';
import { HubReleases } from '../../src/hub/hub-releases.ts';
import { HubTransport } from '../../src/hub/hub-transport.ts';
import { PackageRoots } from '../../src/packages/package-roots.ts';
import { ProjectPackages } from '../../src/packages/project-packages.ts';
import { createPackagesRouter } from '../../src/routes/packages.ts';
import { normalizePath } from '../../src/normalize-path.ts';
import { ArchiveFixture } from '../packages/archive-fixture.ts';
import { LibrarySeed } from '../packages/library-seed.ts';
import { FakeHub } from '../fixtures/fake-hub.ts';

/**
 * The hub's releases for a project's pins (hub-plan H10, "Feeding P10"):
 * the version an install by name would get on this engine, kept 10
 * minutes, never holding the Packages dialog up for long; and
 * `GET /api/packages` counting it in `updates` (`updatesFrom: 'hub'`).
 */

const ENGINE = ArchiveFixture.ENGINE;
const KIT = '@acme/kit';
const ENV_KEYS = ['FLUIDCAD_PACKAGES', 'FLUIDCAD_HOME', 'HOME', 'XDG_CONFIG_HOME', 'APPDATA'] as const;

let hub: FakeHub;
let saved: Record<string, string | undefined>;
let tmp: string;
let project: string;
let clock: number;
let servers: http.Server[];

async function kit(version: string, manifest: Record<string, unknown> = {}): Promise<Buffer> {
  const files = { ...ArchiveFixture.defaultFiles(), 'standoff.feature.js': `export const standoff = () => '${version}';\n` };
  return ArchiveFixture.zip({ version, files, manifest });
}

function releases(options: { hubUrl?: string; waitMs?: number } = {}): HubReleases {
  return new HubReleases({
    engineVersion: ENGINE,
    sdkVersion: 1,
    env: { FLUIDCAD_HUB_URL: options.hubUrl ?? hub.origin },
    transport: new HubTransport({ version: ENGINE, client: 'app', retryDelayMs: 1 }),
    waitMs: options.waitMs,
    now: () => clock,
  });
}

async function closedPort(): Promise<string> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

async function serve(feed: HubReleases): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use('/api', createPackagesRouter({ workspacePath: project, releases: feed }));
  const server = http.createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return `http://127.0.0.1:${(server.address() as net.AddressInfo).port}/api`;
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
  clock = 1_000_000;
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  tmp = normalizePath(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-hub-releases-'))));
  project = path.posix.join(tmp, 'project');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'fluidcad.json'), JSON.stringify({ engine: ENGINE }, null, 2) + '\n');
  process.env.FLUIDCAD_PACKAGES = path.posix.join(tmp, 'library');
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

describe('HubReleases.newest', () => {
  it("answers the newest version this engine runs, asking with its engine and SDK, and keeps it 10 minutes", async () => {
    await hub.addArchive(await kit('0.1.0'));
    await hub.addArchive(await kit('0.2.0'));
    await hub.addArchive(await kit('0.3.0', { minEngine: '0.0.99' }));
    const feed = releases();
    expect(await feed.newest([KIT, '@acme/unknown'])).toEqual({ [KIT]: '0.2.0' });
    expect(hub.requestsTo(`/api/v1/packages/${KIT}`)[0].query).toBe(`?engine=${ENGINE}&sdk=1`);
    expect(hub.requestsTo(`/api/v1/packages/${KIT}`)[0].headers.authorization).toBeUndefined();

    await hub.addArchive(await kit('0.2.5'));
    clock += HubReleases.TTL_MS - 1;
    expect(await feed.newest([KIT, '@acme/unknown'])).toEqual({ [KIT]: '0.2.0' });
    expect(hub.requestsTo(`/api/v1/packages/${KIT}`)).toHaveLength(1);
    expect(hub.requestsTo('/api/v1/packages/@acme/unknown')).toHaveLength(1);

    clock += 2;
    expect(await feed.newest([KIT])).toEqual({ [KIT]: '0.2.5' });
    expect(hub.requestsTo(`/api/v1/packages/${KIT}`)).toHaveLength(2);
  });

  it('gives nothing for an offline hub, and asks again after a minute, not before', async () => {
    const offline = await closedPort();
    const feed = releases({ hubUrl: offline });
    expect(await feed.newest([KIT])).toEqual({});
    clock += HubReleases.FAILURE_TTL_MS - 1;
    const started = Date.now();
    expect(await feed.newest([KIT])).toEqual({});
    expect(Date.now() - started).toBeLessThan(50);
  });

  it("doesn't wait past its limit for a slow hub, and has the answer for the next ask", async () => {
    await hub.addArchive(await kit('0.2.0'));
    hub.packageReadDelayMs = 300;
    const feed = releases({ waitMs: 20 });
    const started = Date.now();
    expect(await feed.newest([KIT])).toEqual({});
    expect(Date.now() - started).toBeLessThan(250);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(await feed.newest([KIT])).toEqual({ [KIT]: '0.2.0' });
    expect(hub.requestsTo(`/api/v1/packages/${KIT}`)).toHaveLength(1);
  });

  it('gives nothing when the hub URL is not one', async () => {
    const feed = new HubReleases({ engineVersion: ENGINE, env: { FLUIDCAD_HUB_URL: 'not a url' } });
    expect(await feed.newest([KIT])).toEqual({});
  });
});

describe('GET /api/packages with the hub releases', () => {
  it("counts the hub's newer version in updates, from the hub", async () => {
    await LibrarySeed.install(await kit('0.1.0'), { project, pin: true });
    await hub.addArchive(await kit('0.1.0'));
    await hub.addArchive(await kit('0.2.0'));
    const base = await serve(releases());
    const overview = await (await fetch(`${base}/packages`)).json();
    expect(overview.updates).toEqual({ [KIT]: '0.2.0' });
    expect(overview.updatesFrom).toEqual({ [KIT]: 'hub' });
  });

  it('says library when the library already holds that version, and keeps the newest of both', async () => {
    await LibrarySeed.install(await kit('0.1.0'), { project, pin: true });
    await LibrarySeed.install(await kit('0.2.0'));
    await hub.addArchive(await kit('0.2.0'));
    const base = await serve(releases());
    const tie = await (await fetch(`${base}/packages`)).json();
    expect(tie.updates).toEqual({ [KIT]: '0.2.0' });
    expect(tie.updatesFrom).toEqual({ [KIT]: 'library' });

    await LibrarySeed.install(await kit('0.4.0'));
    const newer = await (await fetch(`${base}/packages`)).json();
    expect(newer.updates).toEqual({ [KIT]: '0.4.0' });
    expect(newer.updatesFrom).toEqual({ [KIT]: 'library' });
  });

  it('marks a pin whose package the hub lists as deprecated, with its message (H12)', async () => {
    await LibrarySeed.install(await kit('0.1.0'), { project, pin: true });
    await hub.addArchive(await kit('0.1.0'));
    await hub.addArchive(await kit('0.2.0'));
    hub.packages.get(KIT)!.deprecatedMessage = 'Use @acme/other.';
    const base = await serve(releases());
    const overview = await (await fetch(`${base}/packages`)).json();
    expect(overview.hubMarks).toEqual({ [KIT]: { deprecated: 'Use @acme/other.' } });
    expect(overview.updates).toEqual({ [KIT]: '0.2.0' });
  });

  it('marks nothing for a pin the hub has nothing to say about', async () => {
    await LibrarySeed.install(await kit('0.1.0'), { project, pin: true });
    await hub.addArchive(await kit('0.1.0'));
    await hub.addArchive(await kit('0.2.0'));
    const base = await serve(releases());
    const overview = await (await fetch(`${base}/packages`)).json();
    expect(overview.hubMarks).toEqual({});
  });

  it('asks the hub nothing for a project with no pins', async () => {
    const base = await serve(releases());
    const overview = await (await fetch(`${base}/packages`)).json();
    expect(overview.updates).toEqual({});
    expect(hub.requests).toHaveLength(0);
  });
});

describe('ProjectPackages.updates', () => {
  it('takes the newest of the library and the hub above each pin, the library on a tie, and nothing at or below the pin', () => {
    const pins = [
      { name: KIT, version: '0.2.0', integrity: 'x', availability: 'library' as const, directory: null as string | null },
      { name: '@acme/gears', version: '1.0.0', integrity: 'y', availability: 'library' as const, directory: null as string | null },
    ];
    const library = [{ target: 'library' as const, root: '/l', name: KIT, version: '0.3.0', directory: '/l/@acme/kit/0.3.0' }];
    expect(ProjectPackages.updates(pins, library, { [KIT]: '0.3.0', '@acme/gears': '1.0.0' })).toEqual({ updates: { [KIT]: '0.3.0' }, updatesFrom: { [KIT]: 'library' } });
    expect(ProjectPackages.updates(pins, library, { [KIT]: '0.3.1', '@acme/gears': '1.1.0-beta.1' })).toEqual({
      updates: { [KIT]: '0.3.1', '@acme/gears': '1.1.0-beta.1' },
      updatesFrom: { [KIT]: 'hub', '@acme/gears': 'hub' },
    });
  });
});
