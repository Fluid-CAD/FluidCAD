import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ArchiveFixture } from '../packages/archive-fixture.ts';
import { createPackagesRouter } from '../../src/routes/packages.ts';
import { createPreferencesRouter } from '../../src/routes/preferences.ts';
import { PackageRoots } from '../../src/packages/package-roots.ts';
import { LibraryMove } from '../../src/packages/library-move.ts';
import { listWorkspaceFiles } from '../../src/files/file-tree.ts';
import { TreeHash } from '../../src/packages/tree-hash.ts';
import { normalizePath } from '../../src/normalize-path.ts';

// What the engine page's package UI (Settings → Packages, the consent
// dialog, the project's Packages dialog) reads beyond P4's routes: where
// the library path comes from, the "update available" versions, a feature
// icon from an inspected archive, a declined inspection, the copy offered
// after the library folder changed, and an editor tree without the empty
// folders a project copy leaves. The preferences and package routers share
// one app, as in index.ts. HOME (with XDG_CONFIG_HOME and APPDATA) and
// FLUIDCAD_HOME point at temp folders; FLUIDCAD_PACKAGES is set per test.

const ENV_KEYS = ['FLUIDCAD_PACKAGES', 'FLUIDCAD_HOME', 'HOME', 'XDG_CONFIG_HOME', 'APPDATA'] as const;
const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><circle cx="4" cy="4" r="3"/></svg>';

let saved: Record<string, string | undefined>;
let tmp: string;
let project: string;
let servers: http.Server[];

async function serve(): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use('/api', createPreferencesRouter());
  app.use('/api', createPackagesRouter({ workspacePath: project, engineVersion: ArchiveFixture.ENGINE }));
  const server = http.createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
}

async function call(url: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(url, init);
  return { status: res.status, body: await res.json() };
}

function postJson(url: string, body: unknown) {
  return call(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

function withIcon(): Parameters<typeof ArchiveFixture.zip>[0] {
  const files = { ...ArchiveFixture.defaultFiles(), 'standoff.svg': ICON };
  return {
    files,
    manifest: {
      features: [{ id: 'acme.standoff', exportName: 'standoff', module: 'standoff.feature.js', meta: { label: 'Standoff', icon: './standoff.svg' } }],
    },
  };
}

async function install(base: string, options: Parameters<typeof ArchiveFixture.zip>[0] = {}, target = 'library') {
  const inspected = await call(`${base}/packages/inspect?target=${target}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/zip' },
    body: await ArchiveFixture.zip(options),
  });
  expect(inspected.status).toBe(200);
  return postJson(`${base}/packages/install`, { token: inspected.body.token, target, as: ArchiveFixture.publicName(options) });
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

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  tmp = normalizePath(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-package-ui-'))));
  project = path.posix.join(tmp, 'project');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'fluidcad.json'), JSON.stringify({ engine: ArchiveFixture.ENGINE }));
  const home = path.posix.join(tmp, 'home');
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = home;
  process.env.APPDATA = home;
  process.env.FLUIDCAD_HOME = path.posix.join(tmp, 'fluidcad-home');
  delete process.env.FLUIDCAD_PACKAGES;
  PackageRoots.forget();
  LibraryMove.dismiss();
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
  LibraryMove.dismiss();
  writable(tmp);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('GET /api/packages for the page', () => {
  it('says where the library path comes from: the default, the setting, then FLUIDCAD_PACKAGES', async () => {
    const base = await serve();
    expect((await call(`${base}/packages`)).body.library).toMatchObject({
      path: path.posix.join(tmp, 'fluidcad-home', 'packages'),
      source: 'default',
    });

    const chosen = path.posix.join(tmp, 'chosen');
    expect((await postJson(`${base}/preferences`, { packageLibraryPath: chosen })).status).toBe(200);
    expect((await call(`${base}/packages`)).body.library).toMatchObject({ path: chosen, source: 'preference' });

    process.env.FLUIDCAD_PACKAGES = path.posix.join(tmp, 'env-library');
    PackageRoots.forget();
    expect((await call(`${base}/packages`)).body.library).toMatchObject({ path: path.posix.join(tmp, 'env-library'), source: 'env' });
  });

  it('names the newest library version above each pin, and nothing for an up-to-date pin', async () => {
    process.env.FLUIDCAD_PACKAGES = path.posix.join(tmp, 'library');
    const base = await serve();
    const pinned = await install(base, {}, 'project');
    expect(pinned.body.pin).toBe('pinned');
    expect((await call(`${base}/packages`)).body.updates).toEqual({});

    await install(base, { version: '0.2.0' });
    await install(base, { version: '0.1.5' });
    await install(base, { name: '@acme/other', version: '9.0.0' });
    const { body } = await call(`${base}/packages`);
    expect(body.updates).toEqual({ '@acme/kit': '0.2.0' });
    expect(body.pins).toMatchObject([{ name: '@acme/kit', version: '0.1.0', availability: 'project' }]);
  });
});

describe('the consent dialog', () => {
  it('serves a feature icon from the inspected archive, and nothing for an unknown token or feature', async () => {
    process.env.FLUIDCAD_PACKAGES = path.posix.join(tmp, 'library');
    const base = await serve();
    const inspected = await call(`${base}/packages/inspect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip' },
      body: await ArchiveFixture.zip(withIcon()),
    });
    const token = inspected.body.token;

    const res = await fetch(`${base}/packages/inspected-icon?token=${token}&id=acme.standoff`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/image\/svg\+xml/);
    expect(res.headers.get('content-security-policy')).toMatch(/sandbox/);
    expect(await res.text()).toBe(ICON);

    expect((await call(`${base}/packages/inspected-icon?token=nope&id=acme.standoff`)).status).toBe(404);
    expect((await call(`${base}/packages/inspected-icon?token=${token}&id=acme.other`)).status).toBe(404);
    expect((await call(`${base}/packages/inspected-icon?token=${token}`)).status).toBe(400);
  });

  it('refuses an icon that leads outside its feature directory', async () => {
    process.env.FLUIDCAD_PACKAGES = path.posix.join(tmp, 'library');
    const base = await serve();
    const options = withIcon();
    options.files = { ...options.files, 'parts/standoff.feature.js': "export const standoff = () => null;\n" };
    options.manifest = {
      features: [{ id: 'acme.standoff', exportName: 'standoff', module: 'parts/standoff.feature.js', meta: { label: 'Standoff', icon: '../standoff.svg' } }],
    };
    const inspected = await call(`${base}/packages/inspect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip' },
      body: await ArchiveFixture.zip(options),
    });
    expect(inspected.status).toBe(200);
    expect((await call(`${base}/packages/inspected-icon?token=${inspected.body.token}&id=acme.standoff`)).status).toBe(403);
  });

  it('discards a declined inspection, so its token no longer installs and its scratch is gone', async () => {
    const library = path.posix.join(tmp, 'library');
    process.env.FLUIDCAD_PACKAGES = library;
    const base = await serve();
    const inspected = await call(`${base}/packages/inspect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip' },
      body: await ArchiveFixture.zip(),
    });
    expect(fs.readdirSync(path.join(library, '.tmp'))).toHaveLength(1);

    expect((await postJson(`${base}/packages/discard`, { token: inspected.body.token })).status).toBe(200);
    expect(fs.existsSync(path.join(library, '.tmp'))).toBe(false);
    expect((await postJson(`${base}/packages/install`, { token: inspected.body.token, target: 'library' })).status).toBe(404);
    expect((await postJson(`${base}/packages/discard`, {})).status).toBe(400);
  });
});

describe('the library folder changing', () => {
  it('offers the old folder\'s packages, copies them unchanged, and offers nothing after', async () => {
    const base = await serve();
    const before = path.posix.join(tmp, 'fluidcad-home', 'packages');
    await install(base);
    await install(base, { name: '@acme/other', version: '1.0.0' });
    const hash = await TreeHash.ofDirectory(path.join(before, '@acme', 'kit', '0.1.0'));
    expect((await call(`${base}/packages`)).body.libraryOffer).toBeNull();

    const after = path.posix.join(tmp, 'new-library');
    expect((await postJson(`${base}/preferences`, { packageLibraryPath: after })).status).toBe(200);
    const offered = (await call(`${base}/packages`)).body;
    expect(offered.library.packages).toEqual([]);
    expect(offered.libraryOffer).toEqual({
      path: before,
      packages: [{ name: '@acme/kit', version: '0.1.0' }, { name: '@acme/other', version: '1.0.0' }],
    });

    const copied = await call(`${base}/packages/library-offer`, { method: 'POST' });
    expect(copied.status).toBe(200);
    expect(copied.body).toEqual({
      from: before,
      copies: [
        { name: '@acme/kit', version: '0.1.0', status: 'installed' },
        { name: '@acme/other', version: '1.0.0', status: 'installed' },
      ],
    });
    expect(await TreeHash.ofDirectory(path.join(after, '@acme', 'kit', '0.1.0'))).toBe(hash);
    expect(fs.statSync(path.join(after, '@acme', 'kit', '0.1.0', 'index.js')).mode & 0o222).toBe(0);
    // The old folder keeps its copies: a change moves nothing.
    expect(fs.existsSync(path.join(before, '@acme', 'kit', '0.1.0', 'manifest.json'))).toBe(true);
    const listed = (await call(`${base}/packages`)).body;
    expect(listed.libraryOffer).toBeNull();
    expect(listed.library.packages.map((p: any) => `${p.name}@${p.version}`)).toEqual(['@acme/kit@0.1.0', '@acme/other@1.0.0']);
    expect((await call(`${base}/packages/library-offer`, { method: 'POST' })).status).toBe(404);
  });

  it('offers only what the new folder lacks, and forgets the offer when declined or when the folder comes back', async () => {
    const base = await serve();
    const before = path.posix.join(tmp, 'fluidcad-home', 'packages');
    await install(base);
    await install(base, { name: '@acme/other', version: '1.0.0' });
    const after = path.posix.join(tmp, 'new-library');
    await postJson(`${base}/preferences`, { packageLibraryPath: after });
    await install(base);
    expect((await call(`${base}/packages`)).body.libraryOffer).toEqual({ path: before, packages: [{ name: '@acme/other', version: '1.0.0' }] });

    expect((await call(`${base}/packages/library-offer`, { method: 'DELETE' })).status).toBe(200);
    expect((await call(`${base}/packages`)).body.libraryOffer).toBeNull();

    await postJson(`${base}/preferences`, { packageLibraryPath: path.posix.join(tmp, 'third') });
    expect((await call(`${base}/packages`)).body.libraryOffer?.path).toBe(after);
    await postJson(`${base}/preferences`, { packageLibraryPath: after });
    expect((await call(`${base}/packages`)).body.libraryOffer).toBeNull();
  });

  it('makes no offer while FLUIDCAD_PACKAGES holds the library in place, and none after a refused folder', async () => {
    process.env.FLUIDCAD_PACKAGES = path.posix.join(tmp, 'library');
    const base = await serve();
    await install(base);
    await postJson(`${base}/preferences`, { packageLibraryPath: path.posix.join(tmp, 'elsewhere') });
    expect((await call(`${base}/packages`)).body.libraryOffer).toBeNull();

    delete process.env.FLUIDCAD_PACKAGES;
    PackageRoots.forget();
    fs.writeFileSync(path.join(tmp, 'a-file'), 'x');
    expect((await postJson(`${base}/preferences`, { packageLibraryPath: path.posix.join(tmp, 'a-file') })).status).toBe(400);
    expect((await call(`${base}/packages`)).body.libraryOffer).toBeNull();
  });

  it('copies the rest and reports a package the new folder holds with other contents', async () => {
    const base = await serve();
    await install(base);
    await install(base, { name: '@acme/other', version: '1.0.0' });
    const after = path.posix.join(tmp, 'new-library');
    await postJson(`${base}/preferences`, { packageLibraryPath: after });
    const files = { ...ArchiveFixture.defaultFiles(), 'index.js': "export { standoff } from './standoff.feature.js';\n// other\n" };
    await install(base, { files });
    // Same name and version on both sides: present, so not offered...
    expect((await call(`${base}/packages`)).body.libraryOffer.packages).toEqual([{ name: '@acme/other', version: '1.0.0' }]);
    // ...and a copy of everything reports it as refused.
    const copied = await call(`${base}/packages/library-offer`, { method: 'POST' });
    expect(copied.body.copies).toEqual([
      { name: '@acme/kit', version: '0.1.0', status: 'refused', error: expect.stringMatching(/different contents/) },
      { name: '@acme/other', version: '1.0.0', status: 'installed' },
    ]);
  });
});

describe('the editor tree', () => {
  it('drops the folders that only hold a project copy, and keeps the user\'s own', async () => {
    process.env.FLUIDCAD_PACKAGES = path.posix.join(tmp, 'library');
    const base = await serve();
    fs.writeFileSync(path.join(project, 'part1.part.js'), '');
    await install(base, {}, 'project');
    fs.mkdirSync(path.join(project, 'empty-folder'));

    let tree = listWorkspaceFiles(project);
    expect(tree.folders).toEqual(['empty-folder']);
    expect(tree.files.map((file) => file.path)).not.toContain('packages/@acme/kit/0.1.0/index.js');

    fs.mkdirSync(path.join(project, 'packages', 'models'), { recursive: true });
    fs.writeFileSync(path.join(project, 'packages', 'models', 'bracket.part.js'), '');
    fs.mkdirSync(path.join(project, 'packages', '@mine', 'drafts'), { recursive: true });
    tree = listWorkspaceFiles(project);
    expect(tree.folders).toEqual(['empty-folder', 'packages', 'packages/@mine', 'packages/@mine/drafts', 'packages/models']);
  });
});
