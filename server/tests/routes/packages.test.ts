import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ArchiveFixture } from '../packages/archive-fixture.ts';
import { createPackagesRouter } from '../../src/routes/packages.ts';
import { PackageRoots } from '../../src/packages/package-roots.ts';
import { TreeHash } from '../../src/packages/tree-hash.ts';
import { normalizePath } from '../../src/normalize-path.ts';
import { readProjectConfig } from '../../src/project-config.ts';

// The package routes over a temp project and a temp library, with no scene
// and no engine: inspecting and installing read only the archive.
// FLUIDCAD_PACKAGES points at the temp library, and HOME (with
// XDG_CONFIG_HOME and APPDATA) at a temp folder, so the "New packages go to"
// setting read here is this test's, not the developer's.

const ENV_KEYS = ['FLUIDCAD_PACKAGES', 'HOME', 'XDG_CONFIG_HOME', 'APPDATA'] as const;
let saved: Record<string, string | undefined>;
let tmp: string;
let project: string;
let library: string;
let servers: http.Server[];

async function serve(workspacePath: string, maxArchiveBytes?: number): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use('/api', createPackagesRouter({ workspacePath, engineVersion: ArchiveFixture.ENGINE, maxArchiveBytes }));
  const server = http.createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
}

async function call(url: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(url, init);
  return { status: res.status, body: await res.json() };
}

async function inspect(base: string, options: Parameters<typeof ArchiveFixture.zip>[0] = {}) {
  return call(`${base}/packages/inspect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/zip' },
    body: await ArchiveFixture.zip(options),
  });
}

function postJson(url: string, body: unknown) {
  return call(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
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
  tmp = normalizePath(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-packages-route-'))));
  project = path.posix.join(tmp, 'project');
  library = path.posix.join(tmp, 'library');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'fluidcad.json'), JSON.stringify({ engine: ArchiveFixture.ENGINE }));
  process.env.FLUIDCAD_PACKAGES = library;
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

describe('POST /api/packages/inspect', () => {
  it('answers the consent summary and holds the archive for its install', async () => {
    const base = await serve(project);
    const { status, body } = await inspect(base);

    expect(status).toBe(200);
    expect(body).toMatchObject({ manifest: { name: '@acme/kit', version: '0.1.0' }, warnings: [], defaultTarget: 'library' });
    expect(body.token).toEqual(expect.any(String));
    expect(body.integrity).toMatch(/^sha256-/);
  });

  it('refuses an empty body, an old model archive and an archive over the limit', async () => {
    const base = await serve(project);
    expect((await call(`${base}/packages/inspect`, { method: 'POST' })).status).toBe(400);

    const model = await inspect(base, { manifest: null, raw: { 'manifest.json': JSON.stringify({ schemaVersion: 3 }) } });
    expect(model.status).toBe(400);
    expect(model.body.code).toBe('model-archive');
    expect(model.body.error).toMatch(/model archive, not a package/);

    const small = await serve(project, 64);
    const big = await inspect(small);
    expect(big.status).toBe(413);
    expect(big.body.error).toMatch(/larger than/);
  });
});

describe('POST /api/packages/install', () => {
  it('installs into the library without pinning, and into the project with a pin', async () => {
    const base = await serve(project);

    const first = await inspect(base);
    const intoLibrary = await postJson(`${base}/packages/install`, { token: first.body.token, target: 'library' });
    expect(intoLibrary.status).toBe(200);
    expect(intoLibrary.body).toMatchObject({ target: 'library', status: 'installed', pin: null });
    expect(readProjectConfig(project).dependencies).toBeNull();

    const second = await inspect(base);
    const intoProject = await postJson(`${base}/packages/install`, { token: second.body.token, target: 'project' });
    expect(intoProject.body).toMatchObject({ target: 'project', status: 'installed', pin: 'pinned' });
    expect(readProjectConfig(project).dependencies).toEqual({ '@acme/kit': { version: '0.1.0', integrity: second.body.integrity } });
    expect(await TreeHash.ofDirectory(intoProject.body.directory)).toBe(second.body.integrity);
  });

  it('pins a library install on request, and refuses a pin to another version with a 409', async () => {
    const base = await serve(project);
    const first = await inspect(base);
    expect((await postJson(`${base}/packages/install`, { token: first.body.token, target: 'library', pin: true })).body.pin).toBe('pinned');

    const newer = await inspect(base, { version: '0.2.0' });
    const refused = await postJson(`${base}/packages/install`, { token: newer.body.token, target: 'library', pin: true });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('version-change');
    expect(fs.existsSync(path.join(library, '@acme', 'kit', '0.2.0'))).toBe(false);
  });

  it('answers 409 for other contents under the same version, and replaces them when asked', async () => {
    const base = await serve(project);
    const first = await inspect(base);
    await postJson(`${base}/packages/install`, { token: first.body.token, target: 'library' });

    const files = ArchiveFixture.defaultFiles();
    files['index.js'] += '// changed\n';
    const other = await inspect(base, { files });
    const conflict = await postJson(`${base}/packages/install`, { token: other.body.token, target: 'library' });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('conflict');

    const again = await inspect(base, { files });
    const replaced = await postJson(`${base}/packages/install`, { token: again.body.token, target: 'library', replace: true });
    expect(replaced.body.status).toBe('replaced');
  });

  it('refuses a malformed body, a token that is gone, and a project target with no project', async () => {
    const base = await serve(project);
    expect((await postJson(`${base}/packages/install`, { token: 'x', target: 'elsewhere' })).status).toBe(400);
    const gone = await postJson(`${base}/packages/install`, { token: 'not-a-token', target: 'library' });
    expect(gone.status).toBe(404);
    expect(gone.body.code).toBe('unknown-token');

    const noProject = await serve('');
    const inspected = await inspect(noProject);
    expect(inspected.body.defaultTarget).toBe('library');
    expect((await postJson(`${noProject}/packages/install`, { token: inspected.body.token, target: 'project' })).status).toBe(400);
  });
});

describe('GET, copy and DELETE', () => {
  it('lists both roots and the pins with where each is installed', async () => {
    const base = await serve(project);
    const first = await inspect(base);
    await postJson(`${base}/packages/install`, { token: first.body.token, target: 'library', pin: true });
    fs.writeFileSync(path.join(project, 'fluidcad.json'), JSON.stringify({
      engine: ArchiveFixture.ENGINE,
      dependencies: {
        '@acme/kit': { version: '0.1.0', integrity: first.body.integrity },
        '@acme/gears': { version: '1.2.0', integrity: first.body.integrity },
      },
    }));

    const { status, body } = await call(`${base}/packages`);
    expect(status).toBe(200);
    expect(body.library.path).toBe(library);
    expect(body.library.packages.map((p: any) => `${p.name}@${p.version}`)).toEqual(['@acme/kit@0.1.0']);
    expect(body.project).toEqual({ path: path.posix.join(project, 'packages'), packages: [] });
    expect(body.pins.map((p: any) => [p.name, p.availability])).toEqual([['@acme/gears', 'missing'], ['@acme/kit', 'library']]);
    expect(body.defaultTarget).toBe('library');
  });

  it('copies into the project and back, and removes from either root', async () => {
    const base = await serve(project);
    const first = await inspect(base);
    await postJson(`${base}/packages/install`, { token: first.body.token, target: 'library', pin: true });

    const copied = await postJson(`${base}/packages/copy`, { name: '@acme/kit', version: '0.1.0', to: 'project' });
    expect(copied.status).toBe(200);
    expect(copied.body).toMatchObject({ target: 'project', integrity: first.body.integrity });

    const fromLibrary = await call(`${base}/packages/@acme/kit/0.1.0?target=library`, { method: 'DELETE' });
    expect(fromLibrary.status).toBe(200);
    expect(fromLibrary.body).toMatchObject({ removed: { target: 'library', version: '0.1.0' }, strandedPin: null });

    // The only version left, named by package alone; now nothing installs the pin.
    const fromProject = await call(`${base}/packages/@acme/kit?target=project`, { method: 'DELETE' });
    expect(fromProject.body.strandedPin).toMatchObject({ name: '@acme/kit', availability: 'missing' });

    const absent = await call(`${base}/packages/@acme/kit/0.1.0`, { method: 'DELETE' });
    expect(absent.status).toBe(400);
    expect(absent.body.code).toBe('not-installed');
    expect((await call(`${base}/packages/@acme/kit/0.1.0?target=nowhere`, { method: 'DELETE' })).status).toBe(400);
    expect((await postJson(`${base}/packages/copy`, { name: 'kit', version: '0.1.0', to: 'project' })).status).toBe(400);
  });
});
