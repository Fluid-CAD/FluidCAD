import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { HubConfig } from '../../src/hub/hub-config.ts';
import { HubInstallError, HubInstallMessages } from '../../src/hub/hub-install-error.ts';
import { HubInstaller, type ResolvedHubPackage } from '../../src/hub/hub-installer.ts';
import { HubTransport } from '../../src/hub/hub-transport.ts';
import { PackageArchive, PackageArchiveError } from '../../src/packages/package-archive.ts';
import { PackagePins } from '../../src/packages/package-pins.ts';
import { PackageRoots } from '../../src/packages/package-roots.ts';
import { ProjectPackages } from '../../src/packages/project-packages.ts';
import { TreeHash } from '../../src/packages/tree-hash.ts';
import { normalizePath } from '../../src/normalize-path.ts';
import { ArchiveFixture } from '../packages/archive-fixture.ts';
import { FakeHub, type FakeHubUser } from '../fixtures/fake-hub.ts';

/**
 * `HubInstaller` and `HubDownload` (hub-plan Stage H8) against the
 * in-process `FakeHub`, over archives built in memory in the packer's
 * shape: which version a spec resolves to (exact, latest, the newest
 * compatible one, yanked, removed, unpublished), the download verified
 * against the hub's header and the pin, the missing pins of a project,
 * and every failure leaving no scratch behind. FLUIDCAD_PACKAGES is a temp
 * library, so nothing reaches the user's own.
 */

const ENGINE = ArchiveFixture.ENGINE;
const NAME = '@acme/kit';

let hub: FakeHub;
let savedPackages: string | undefined;
let tmp: string;
let project: string;
let library: string;

function installer(options: { token?: string | null; engine?: string; stallMs?: number; hubUrl?: string } = {}): HubInstaller {
  return new HubInstaller({
    config: HubConfig.resolve({ hub: options.hubUrl ?? hub.origin, env: {} }),
    token: options.token ?? null,
    engineVersion: options.engine ?? ENGINE,
    sdkVersion: 1,
    transport: new HubTransport({ version: ENGINE, retryDelayMs: 1 }),
    stallMs: options.stallMs,
  });
}

/** `@acme/kit` at `version` on the hub, built like the packer builds it. */
async function publish(version: string, manifest: Record<string, unknown> = {}, row: Parameters<FakeHub['addArchive']>[1] = {}) {
  const files = { ...ArchiveFixture.defaultFiles(), 'standoff.feature.js': `export const standoff = () => '${version}';\n` };
  return hub.addArchive(await ArchiveFixture.zip({ version, files, manifest }), row);
}

/** `@acme/kit` at `version` installed into `root` from the same files {@link publish} uploads (or other ones). */
async function installLocally(version: string, options: { target?: 'library' | 'project'; feature?: string } = {}): Promise<string> {
  const target = options.target ?? 'library';
  const files = { ...ArchiveFixture.defaultFiles(), 'standoff.feature.js': options.feature ?? `export const standoff = () => '${version}';\n` };
  const inspection = await PackageArchive.inspect(await ArchiveFixture.zip({ version, files }), { root: PackageRoots.rootFor(target, project), engineVersion: ENGINE });
  const outcome = await ProjectPackages.installInspected({ token: inspection.token, target, project });
  return outcome.integrity;
}

async function refusal(promise: Promise<unknown>): Promise<HubInstallError> {
  const err: unknown = await promise.then((): unknown => null, (e: unknown): unknown => e);
  expect(err).toBeInstanceOf(HubInstallError);
  return err as HubInstallError;
}

function scratchEntries(root: string): string[] {
  try {
    return fs.readdirSync(path.join(root, '.tmp'));
  } catch {
    return [];
  }
}

function owner(role: FakeHubUser['role'] = 'user', handle = 'acme'): string {
  return hub.issueToken({ kind: 'cli', scopes: ['publish'], user: { ...FakeHub.DEFAULT_USER, handle, role } }).token;
}

/** A local port nothing listens on: an offline hub. */
async function closedPort(): Promise<string> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

beforeAll(async () => {
  hub = await FakeHub.start();
});

afterAll(async () => {
  await hub.stop();
});

beforeEach(() => {
  hub.reset();
  savedPackages = process.env.FLUIDCAD_PACKAGES;
  tmp = normalizePath(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-hub-install-'))));
  project = path.posix.join(tmp, 'project');
  library = path.posix.join(tmp, 'library');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'fluidcad.json'), JSON.stringify({ engine: ENGINE }, null, 2) + '\n');
  fs.writeFileSync(path.join(project, 'init.js'), '');
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
  TempTree.remove(tmp);
});

/** Installed files are read-only; make them writable so the temp tree can go. */
class TempTree {
  static remove(dir: string): void {
    TempTree.writable(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  private static writable(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        TempTree.writable(child);
      } else if (entry.isFile()) {
        fs.chmodSync(child, 0o644);
      }
    }
  }
}

describe('HubInstaller.resolve', () => {
  it('a name alone takes the latest version, asking the hub with this engine and SDK', async () => {
    await publish('0.1.0');
    const latest = await publish('0.2.0');
    const resolved = await installer().resolve({ name: NAME, version: null });
    expect(resolved).toMatchObject({ name: NAME, version: '0.2.0', integrity: latest.integrity, status: 'published', access: 'public', notes: [] });
    expect(hub.requestsTo(`/api/v1/packages/${NAME}`)[0].query).toBe('?engine=0.0.46&sdk=1');
  });

  it('picks the newest compatible version when the latest needs a newer engine, with a note', async () => {
    const older = await publish('0.1.0');
    await publish('0.2.0', { minEngine: '0.0.99' });
    const resolved = await installer().resolve({ name: NAME, version: null });
    expect(resolved.version).toBe('0.1.0');
    expect(resolved.integrity).toBe(older.integrity);
    expect(resolved.notes).toEqual([
      'The latest @acme/kit, 0.2.0, needs FluidCAD 0.0.99 or newer; this FluidCAD is 0.0.46, so this installs 0.1.0, the newest version it runs.',
    ]);
  });

  it('names the SDK when that is what the latest needs, and refuses when no version runs here', async () => {
    await publish('0.1.0', { minEngine: '0.0.99' });
    await publish('0.2.0', { sdkVersion: 2 });
    const error = await refusal(installer().resolve({ name: NAME, version: null }));
    expect(error.code).toBe('incompatible');
    expect(error.message).toBe(
      'No published version of @acme/kit runs on this FluidCAD (0.0.46, feature SDK 1): the latest, 0.2.0, needs feature SDK version 2 (this FluidCAD has 1). ' +
        HubInstallMessages.UPDATE_HINT,
    );
  });

  it('a name alone never picks a yanked version; an exact version installs it, with a note', async () => {
    await publish('0.1.0');
    const yanked = await publish('0.2.0', {}, { yanked: { at: '2026-10-10T00:00:00.000Z', reason: 'breaks the standoff' } });
    expect((await installer().resolve({ name: NAME, version: null })).version).toBe('0.1.0');

    const exact = await installer().resolve({ name: NAME, version: '0.2.0' });
    expect(exact.integrity).toBe(yanked.integrity);
    expect(exact.yanked).toEqual({ at: '2026-10-10T00:00:00.000Z', reason: 'breaks the standoff' });
    expect(exact.notes).toEqual(['@acme/kit@0.2.0 was yanked (breaks the standoff): it installs because you asked for this version, but an install by name never picks it.']);
  });

  it('says a deprecated package is deprecated, first among the notes, by name and by exact version (H12)', async () => {
    await publish('0.1.0');
    const yanked = await publish('0.2.0', {}, { yanked: { at: '2026-10-10T00:00:00.000Z', reason: 'breaks the standoff' } });
    hub.packages.get(NAME)!.deprecatedMessage = 'Use @acme/other instead.';
    const byName = await installer().resolve({ name: NAME, version: null });
    expect([byName.version, byName.deprecated, byName.notes]).toEqual(['0.1.0', 'Use @acme/other instead.', ['@acme/kit is deprecated: Use @acme/other instead.']]);
    const exact = await installer().resolve({ name: NAME, version: '0.2.0' });
    expect(exact.integrity).toBe(yanked.integrity);
    expect(exact.notes).toEqual([
      '@acme/kit is deprecated: Use @acme/other instead.',
      '@acme/kit@0.2.0 was yanked (breaks the standoff): it installs because you asked for this version, but an install by name never picks it.',
    ]);
    hub.packages.get(NAME)!.deprecatedMessage = null;
    expect((await installer().resolve({ name: NAME, version: null })).notes).toEqual([]);
  });

  it('refuses a removed version with its reason, and an unknown one', async () => {
    await publish('0.1.0', {}, { removed: { at: '2026-10-10T00:00:00.000Z', reason: 'malware' } });
    await publish('0.2.0');
    const removed = await refusal(installer().resolve({ name: NAME, version: '0.1.0' }));
    expect(removed.code).toBe('version-removed');
    expect(removed.message).toBe(`@acme/kit@0.1.0 was removed from ${hub.origin} by its admins (malware), and can't be installed.`);

    const unknown = await refusal(installer().resolve({ name: NAME, version: '9.9.9' }));
    expect(unknown.code).toBe('not-found');
    expect(unknown.message).toContain(`@acme/kit@9.9.9 isn't on ${hub.origin}.`);
    expect((await refusal(installer().resolve({ name: '@acme/gears', version: null }))).code).toBe('not-found');
  });

  it('an unpublished version installs only by exact version, for its owner or an admin', async () => {
    await publish('0.1.0', {}, { status: 'in_review', publishedAt: null });

    const anonymous = await refusal(installer().resolve({ name: NAME, version: '0.1.0' }));
    expect(anonymous.code).toBe('not-found');
    expect(anonymous.message).toContain('sign in with `fluidcad login` first');
    expect((await refusal(installer({ token: owner('user', 'bea') }).resolve({ name: NAME, version: '0.1.0' }))).code).toBe('not-found');

    const mine = await installer({ token: owner() }).resolve({ name: NAME, version: '0.1.0' });
    expect(mine).toMatchObject({ version: '0.1.0', status: 'in_review', access: 'owner' });
    expect(mine.notes).toEqual(["@acme/kit@0.1.0 isn't published: it is in review, and you can install it as its owner."]);
    const reviewer = await installer({ token: owner('admin', 'reviewer') }).resolve({ name: NAME, version: '0.1.0' });
    expect(reviewer.notes[0]).toContain('you can install it as its reviewer.');

    const byName = await refusal(installer({ token: owner() }).resolve({ name: NAME, version: null }));
    expect(byName.code).toBe('nothing-published');
    expect(byName.message).toBe(
      `@acme/kit has no published version on ${hub.origin} yet. Install 0.1.0, which isn't published yet, by its exact version: \`fluidcad install @acme/kit@0.1.0\`.`,
    );
  });

  it('drops a token the hub refuses and reads again anonymously, with a note', async () => {
    await publish('0.1.0');
    const stale = owner();
    hub.tokenOf(stale)!.revoked = true;
    const resolved = await installer({ token: stale }).resolve({ name: NAME, version: null });
    expect(resolved.version).toBe('0.1.0');
    expect(resolved.notes).toEqual([`${hub.origin} refused your saved token (revoked or expired), so this ran signed out: run \`fluidcad login\` to sign in again.`]);
    const reads = hub.requestsTo(`/api/v1/packages/${NAME}`);
    expect(reads.map((r) => r.headers.authorization !== undefined)).toEqual([true, false]);
  });

  it('says clearly when the hub is offline', async () => {
    const error = await refusal(installer({ hubUrl: await closedPort() }).resolve({ name: NAME, version: null }));
    expect(error.code).toBe('network');
    expect(error.message).toMatch(/^Couldn't reach http:\/\/127\.0\.0\.1:\d+: ECONNREFUSED\. /);
    expect(error.message).toContain(HubInstallMessages.OFFLINE_HINT);
    // Packages install only from the hub (HD31): the hint names no file.
    expect(HubInstallMessages.OFFLINE_HINT).toBe('Nothing was installed. Check the connection and try again; a package already in your library installs without the hub.');
  });
});

describe('HubInstaller.choose', () => {
  const packageRoute = `/api/v1/packages/${NAME}`;

  describe('a name alone asks the hub first', () => {
    it('downloads the hub\'s latest when the library holds an older version', async () => {
      await publish('0.1.0');
      const latest = await publish('0.2.0');
      await installLocally('0.1.0');
      const choice = await installer().choose({ name: NAME, version: null }, { project });
      expect(choice.source).toBe('hub');
      expect(choice.source === 'hub' && choice.resolved).toMatchObject({ version: '0.2.0', integrity: latest.integrity, notes: [] });
      expect(hub.requestsTo(packageRoute)).toHaveLength(1);
    });

    it('uses the installed copy of the latest, with no download, when it has the hub\'s contents', async () => {
      await publish('0.1.0');
      const latest = await publish('0.2.0');
      await installLocally('0.2.0');
      const choice = await installer().choose({ name: NAME, version: null }, { project });
      expect(choice).toMatchObject({ source: 'installed', notes: [], resolved: { version: '0.2.0', integrity: latest.integrity } });
      expect(choice.source === 'installed' && choice.location).toMatchObject({ target: 'library', name: NAME, version: '0.2.0' });
      expect(hub.downloads).toHaveLength(0);

      // Outside a project too: the library is the only root.
      expect((await installer().choose({ name: NAME, version: null })).source).toBe('installed');
    });

    it('downloads when the installed copy of the latest has other contents', async () => {
      await publish('0.2.0');
      await installLocally('0.2.0', { feature: 'export const standoff = () => 1;\n' });
      const choice = await installer().choose({ name: NAME, version: null }, { project });
      expect(choice.source).toBe('hub');
    });

    it('takes the newest compatible version when the latest needs a newer engine, with its note', async () => {
      const older = await publish('0.1.0');
      await publish('0.2.0', { minEngine: '0.0.99' });
      const note = 'The latest @acme/kit, 0.2.0, needs FluidCAD 0.0.99 or newer; this FluidCAD is 0.0.46, so this installs 0.1.0, the newest version it runs.';
      const downloaded = await installer().choose({ name: NAME, version: null }, { project });
      expect(downloaded).toMatchObject({ source: 'hub', resolved: { version: '0.1.0', integrity: older.integrity, notes: [note] } });

      await installLocally('0.1.0');
      const installed = await installer().choose({ name: NAME, version: null }, { project });
      expect(installed).toMatchObject({ source: 'installed', location: { version: '0.1.0' }, notes: [note] });
    });

    it('with the hub unreachable, uses the newest installed version, with a note', async () => {
      await installLocally('0.1.0');
      await installLocally('0.3.0');
      const offline = await closedPort();
      const choice = await installer({ hubUrl: offline }).choose({ name: NAME, version: null }, { project });
      expect(choice).toMatchObject({ source: 'installed', resolved: null, location: { target: 'library', version: '0.3.0' } });
      expect(choice.source === 'installed' && choice.notes).toEqual([
        `Couldn't reach ${offline}, so this uses @acme/kit 0.3.0 from your library, the newest version there; the hub may have a newer one.`,
      ]);
    });

    it('treats a hub failing on its side (5xx) as unreachable', async () => {
      await publish('0.2.0');
      await installLocally('0.1.0');
      hub.failNext(packageRoute, 500);
      expect(await installer().choose({ name: NAME, version: null }, { project })).toMatchObject({ source: 'installed', location: { version: '0.1.0' } });
      hub.failNext(packageRoute, 503, 2);
      expect(await installer().choose({ name: NAME, version: null }, { project })).toMatchObject({ source: 'installed', location: { version: '0.1.0' } });
    });

    it('with the hub unreachable and nothing installed, refuses with the offline error', async () => {
      const error = await refusal(installer({ hubUrl: await closedPort() }).choose({ name: NAME, version: null }, { project }));
      expect(error.code).toBe('network');
      expect(error.message).toContain(HubInstallMessages.OFFLINE_HINT);
    });

    it('refuses a package the hub doesn\'t know, even with a copy installed, naming the exact-version install', async () => {
      await installLocally('0.1.0');
      const error = await refusal(installer().choose({ name: NAME, version: null }, { project }));
      expect(error.code).toBe('not-found');
      expect(error.message).toBe(
        `@acme/kit isn't on ${hub.origin}. If it's yours or you review it and it isn't published yet, sign in with \`fluidcad login\` first. ` +
          'Your library has a local copy, @acme/kit 0.1.0: `fluidcad install @acme/kit@0.1.0` installs it by its exact version, without the hub.',
      );
      expect(error.details).toEqual({ installed: '0.1.0', target: 'library' });

      // That exact version is then taken from the library without asking the hub.
      hub.requests.length = 0;
      expect(await installer().choose({ name: NAME, version: '0.1.0' }, { project })).toMatchObject({ source: 'installed', location: { version: '0.1.0' } });
      expect(hub.requests).toHaveLength(0);
    });

    it('passes on any other refusal, such as a rate limit, without falling back', async () => {
      await installLocally('0.1.0');
      hub.failNext(packageRoute, 429);
      const error = await refusal(installer().choose({ name: NAME, version: null }, { project }));
      expect(error.code).not.toBe('not-found');
      expect(error.hubUnreachable).toBe(false);
    });
  });

  describe('an exact or pinned version takes the installed copy first (unchanged)', () => {
    it('an exact version installed is used without asking the hub, even when the hub has a newer one', async () => {
      await publish('0.1.0');
      await publish('0.2.0');
      await installLocally('0.1.0');
      const choice = await installer().choose({ name: NAME, version: '0.1.0' }, { project });
      expect(choice).toMatchObject({ source: 'installed', resolved: null, notes: [], location: { version: '0.1.0' } });
      expect(hub.requests).toHaveLength(0);
    });

    it('an exact version not installed comes from the hub', async () => {
      const first = await publish('0.1.0');
      await publish('0.2.0');
      const choice = await installer().choose({ name: NAME, version: '0.1.0' }, { project });
      expect(choice).toMatchObject({ source: 'hub', resolved: { version: '0.1.0', integrity: first.integrity } });
    });

    it('a name alone in a project that pins it means the pinned version', async () => {
      const first = await publish('0.1.0');
      await publish('0.2.0');
      PackagePins.pin(project, NAME, '0.1.0', first.integrity!);
      const missing = await installer().choose({ name: NAME, version: null }, { project });
      expect(missing).toMatchObject({ source: 'hub', resolved: { version: '0.1.0' } });

      await installLocally('0.1.0');
      hub.requests.length = 0;
      const installed = await installer().choose({ name: NAME, version: null }, { project });
      expect(installed).toMatchObject({ source: 'installed', location: { version: '0.1.0' } });
      expect(hub.requests).toHaveLength(0);
    });
  });
});

describe('HubInstaller.fetch', () => {
  it('downloads, inspects and verifies a package, which installs into the library and pins in a project', async () => {
    const row = await publish('0.1.0');
    const hubInstaller = installer();
    const resolved = await hubInstaller.resolve({ name: NAME, version: null });
    const fetched = await hubInstaller.fetch(resolved, { root: PackageRoots.rootFor('library', project) });
    expect(fetched.inspection.integrity).toBe(row.integrity);
    expect(fetched.inspection.manifest).toMatchObject({ name: NAME, version: '0.1.0' });
    expect(hub.downloadsOf(NAME, '0.1.0')).toHaveLength(1);

    const outcome = await ProjectPackages.installInspected({ token: fetched.inspection.token, target: 'library', project, pin: true });
    expect(outcome).toMatchObject({ status: 'installed', pin: 'pinned', integrity: row.integrity });
    expect(await TreeHash.ofDirectory(path.join(library, '@acme', 'kit', '0.1.0'))).toBe(row.integrity);
    expect(PackagePins.of(project)[NAME]).toEqual({ version: '0.1.0', integrity: row.integrity });
    expect(scratchEntries(library)).toEqual([]);
  });

  it('sends the token on the download, so the owner can fetch an unpublished version', async () => {
    await publish('0.1.0', {}, { status: 'draft', publishedAt: null });
    const token = owner();
    const hubInstaller = installer({ token });
    const fetched = await hubInstaller.fetch(await hubInstaller.resolve({ name: NAME, version: '0.1.0' }), { root: library });
    expect(fetched.resolved.status).toBe('draft');
    expect(hub.downloadsOf(NAME, '0.1.0')[0].headers.authorization).toBe(`Bearer ${token}`);
    PackageArchive.discard(fetched.inspection.token);
  });

  it("refuses bytes whose tree hash isn't the hub's header, naming both, and leaves no scratch", async () => {
    await publish('0.1.0');
    const hubInstaller = installer();
    const resolved = await hubInstaller.resolve({ name: NAME, version: '0.1.0' });
    hub.nextDownload = { bytes: await ArchiveFixture.zip({ version: '0.1.0' }) };
    const error = await refusal(hubInstaller.fetch(resolved, { root: library }));
    expect(error.code).toBe('integrity-mismatch');
    expect(error.message).toMatch(new RegExp(`^The downloaded @acme/kit@0\\.1\\.0 hashes to sha256-\\S+, but ${hub.origin.replace(/\./g, '\\.')} says ${resolved.integrity.replace(/[+/]/g, '\\$&')}\\. Nothing was installed\\.$`));
    expect((error.details as { hub: string }).hub).toBe(resolved.integrity);
    expect((error.details as { computed: string }).computed).not.toBe(resolved.integrity);
    expect(scratchEntries(library)).toEqual([]);
    expect(fs.existsSync(path.join(library, '@acme'))).toBe(false);
  });

  it("refuses a download whose header isn't what the hub listed, before reading the body", async () => {
    await publish('0.1.0');
    const hubInstaller = installer();
    const resolved = await hubInstaller.resolve({ name: NAME, version: '0.1.0' });
    hub.nextDownload = { integrity: 'sha256-AAAA' };
    const error = await refusal(hubInstaller.fetch(resolved, { root: library }));
    expect(error.code).toBe('integrity-mismatch');
    expect(error.message).toBe(`${hub.origin} lists @acme/kit@0.1.0 as ${resolved.integrity}, but its download says sha256-AAAA. Nothing was installed.`);
    expect(scratchEntries(library)).toEqual([]);
  });

  it("refuses a version the pin doesn't match before downloading, naming the hub's integrity and the pin's", async () => {
    const row = await publish('0.1.0');
    const hubInstaller = installer();
    const resolved = await hubInstaller.resolve({ name: NAME, version: '0.1.0' });
    const error = await refusal(hubInstaller.fetch(resolved, { root: library, pin: 'sha256-PINNED' }));
    expect(error.code).toBe('integrity-mismatch');
    expect(error.message).toBe(
      `${hub.origin} lists @acme/kit@0.1.0 as ${row.integrity}, but this project pins it as sha256-PINNED: these aren't the files the project was built with. Nothing was downloaded. Nothing was installed.`,
    );
    expect(hub.downloads).toHaveLength(0);
  });

  it('names all three when the bytes match neither the header nor the pin', async () => {
    const row = await publish('0.1.0');
    const hubInstaller = installer();
    const resolved = await hubInstaller.resolve({ name: NAME, version: '0.1.0' });
    hub.nextDownload = { bytes: await ArchiveFixture.zip({ version: '0.1.0' }) };
    const error = await refusal(hubInstaller.fetch(resolved, { root: library, pin: row.integrity! }));
    expect(error.message).toContain(`but ${hub.origin} says ${row.integrity}, and this project pins ${row.integrity}.`);
    expect(error.details).toMatchObject({ hub: row.integrity, pin: row.integrity });
  });

  it('refuses an archive of another package or version', async () => {
    await publish('0.1.0');
    const hubInstaller = installer();
    const resolved: ResolvedHubPackage = { ...(await hubInstaller.resolve({ name: NAME, version: '0.1.0' })) };
    const other = await ArchiveFixture.zip({ version: '0.3.0' });
    const hash = (await hub.addArchive(other, { status: 'rejected' })).integrity!;
    hub.nextDownload = { bytes: other, integrity: hash };
    const error = await refusal(hubInstaller.fetch({ ...resolved, integrity: hash }, { root: library }));
    expect(error.code).toBe('wrong-package');
    expect(error.message).toBe(`${hub.origin} answered @acme/kit@0.1.0 with an archive of @acme/kit@0.3.0. Nothing was installed.`);
    expect(scratchEntries(library)).toEqual([]);
  });

  it('aborts a download that stalls mid-body and leaves no scratch', async () => {
    await publish('0.1.0');
    const hubInstaller = installer({ stallMs: 150 });
    const resolved = await hubInstaller.resolve({ name: NAME, version: '0.1.0' });
    hub.nextDownload = { stallAfterBytes: 100 };
    const started = Date.now();
    const error = await refusal(hubInstaller.fetch(resolved, { root: library }));
    expect(error.code).toBe('stalled');
    expect(error.message).toBe(`The download of @acme/kit@0.1.0 from ${hub.origin} stalled: nothing came for 150 ms. ${HubInstallMessages.OFFLINE_HINT}`);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(scratchEntries(library)).toEqual([]);
  });

  it("refuses an archive over the hub's archiveBytes before reading it, and a body cut short", async () => {
    await publish('0.1.0');
    const hubInstaller = installer();
    const resolved = await hubInstaller.resolve({ name: NAME, version: '0.1.0' });
    hub.limits = { archiveBytes: 64 };
    const big = await refusal(installer().fetch(resolved, { root: library }));
    expect(big.code).toBe('too-large');
    expect(big.message).toBe(`@acme/kit@0.1.0 is ${resolved.size} bytes, more than the 64 bytes ${hub.origin} serves for an archive.`);

    hub.limits = {};
    hub.nextDownload = { truncateAfterBytes: 100 };
    const short = await refusal(installer().fetch(resolved, { root: library }));
    expect(['truncated', 'network']).toContain(short.code);
    expect(short.message).toContain('Nothing was installed');
    expect(scratchEntries(library)).toEqual([]);
  });

  it('stops when the caller aborts', async () => {
    await publish('0.1.0');
    const hubInstaller = installer();
    const resolved = await hubInstaller.resolve({ name: NAME, version: '0.1.0' });
    hub.nextDownload = { stallAfterBytes: 10 };
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const error = await refusal(hubInstaller.fetch(resolved, { root: library, signal: controller.signal }));
    expect(error.code).toBe('aborted');
    expect(error.message).toBe('The download of @acme/kit@0.1.0 was stopped.');
    expect(scratchEntries(library)).toEqual([]);
  });

  it("passes on the hub's refusal of the download itself", async () => {
    await publish('0.1.0');
    const hubInstaller = installer();
    const resolved = await hubInstaller.resolve({ name: NAME, version: '0.1.0' });
    hub.nextDownload = { error: { status: 429, code: 'rate-limited', message: 'Too many downloads from this address.' } };
    const error = await refusal(hubInstaller.fetch(resolved, { root: library }));
    expect(error.code).toBe('rate-limited');
    expect(error.message).toBe('Too many downloads from this address. Wait a minute, then install again.');
  });
});

describe('HubInstaller.missing', () => {
  it("fetches every missing pin at its version against its integrity, and collects each failure", async () => {
    const kit = await publish('0.1.0');
    await publish('0.2.0');
    const gears = await hub.addArchive(await ArchiveFixture.zip({ name: '@acme/gears', version: '1.2.0' }));
    const pins = [
      { name: '@acme/gears', version: '1.2.0', integrity: gears.integrity!, availability: 'missing' as const, directory: null as string | null },
      { name: NAME, version: '0.1.0', integrity: kit.integrity!, availability: 'missing' as const, directory: null as string | null },
      { name: '@acme/bolts', version: '2.0.0', integrity: 'sha256-x', availability: 'missing' as const, directory: null as string | null },
    ];
    const started: string[] = [];
    const result = await installer().missing(pins, { root: library, onStart: (pin) => started.push(pin.name) });
    expect(started).toEqual(['@acme/gears', NAME, '@acme/bolts']);
    expect(result.fetched.map((f) => `${f.inspection.manifest.name}@${f.inspection.manifest.version}`)).toEqual(['@acme/gears@1.2.0', '@acme/kit@0.1.0']);
    expect(result.fetched.map((f) => `${f.resolved.name}@${f.resolved.version}`)).toEqual(['@acme/gears@1.2.0', '@acme/kit@0.1.0']);
    expect(result.fetched.map((f) => f.inspection.integrity)).toEqual([gears.integrity, kit.integrity]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({ name: '@acme/bolts', version: '2.0.0' });
    expect((result.failed[0].error as HubInstallError).code).toBe('not-found');

    HubInstaller.discard(result.fetched);
    expect(scratchEntries(library)).toEqual([]);
  });
});

/**
 * HD30: an archive names its package in full (`@acme/kit`), and the hub
 * serves it at that name; two publishers can each have a `…/kit`. An
 * archive packed under HD29 (a manifest name without its scope) is refused
 * on download, never converted.
 */
describe('package names with their scope (HD30)', () => {
  it('installs a download under its manifest\'s name, and two publishers\' packages of one name side by side', async () => {
    const acme = await publish('0.1.0');
    const beaFiles = { ...ArchiveFixture.defaultFiles(), 'standoff.feature.js': "export const standoff = () => 'bea';\n" };
    const bea = await hub.addArchive(await ArchiveFixture.zip({ name: '@bea-tools/kit', version: '0.1.0', files: beaFiles }));
    expect(acme.integrity).not.toBe(bea.integrity);

    for (const name of [NAME, '@bea-tools/kit']) {
      const resolved = await installer().resolve({ name, version: null });
      const fetched = await installer().fetch(resolved, { root: library });
      expect(fetched.inspection.manifest.name).toBe(name);
      const outcome = await ProjectPackages.installInspected({ token: fetched.inspection.token, target: 'library', project, pin: true });
      expect(outcome).toMatchObject({ name, directory: path.posix.join(library, ...name.split('/'), '0.1.0'), pin: 'pinned' });
    }
    expect(Object.keys(PackagePins.of(project)).sort()).toEqual(['@acme/kit', '@bea-tools/kit']);
  });

  it('refuses another publisher\'s bytes served for the package asked for, before anything installs', async () => {
    await publish('0.1.0');
    const hubInstaller = installer();
    const resolved = await hubInstaller.resolve({ name: NAME, version: '0.1.0' });
    const bea = await ArchiveFixture.zip({ name: '@bea-tools/kit', version: '0.1.0' });
    const hash = (await hub.addArchive(bea, { status: 'rejected' })).integrity!;
    hub.nextDownload = { bytes: bea, integrity: hash };
    const error = await refusal(hubInstaller.fetch({ ...resolved, integrity: hash }, { root: library }));
    expect(error.code).toBe('wrong-package');
    expect(error.message).toBe(`${hub.origin} answered @acme/kit@0.1.0 with an archive of @bea-tools/kit@0.1.0. Nothing was installed.`);
    expect(scratchEntries(library)).toEqual([]);
    expect(fs.existsSync(path.join(library, '@acme', 'kit'))).toBe(false);
  });

  it('refuses an archive packed under HD29 with the pack-again sentence, installing nothing and leaving no scratch', async () => {
    const old = await ArchiveFixture.zip({ name: 'kit', version: '0.1.0' });
    await hub.addArchive(old, {}, '@acme/old-tests');
    const hubInstaller = installer();
    const resolved = await hubInstaller.resolve({ name: '@acme/old-tests', version: null });
    const err: unknown = await hubInstaller.fetch(resolved, { root: library }).then((): unknown => null, (e: unknown): unknown => e);
    expect(err).toBeInstanceOf(PackageArchiveError);
    expect(err).toMatchObject({ code: 'bad-manifest', message: PackageArchive.unscopedNameSentence('kit') });
    expect(scratchEntries(library)).toEqual([]);
    expect(fs.existsSync(path.join(library, '@acme'))).toBe(false);
  });

  it('refuses a bare name with the publisher hint', () => {
    expect(HubInstaller.noPublisherRefusal('feature-tests')).toMatchObject({
      code: 'no-publisher',
      message: 'Name the publisher: `fluidcad install @<handle>/feature-tests`.',
    });
  });
});
