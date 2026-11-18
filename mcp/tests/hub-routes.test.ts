// The hub and package tools end to end, short of a network: the MCP tools
// call the real `/api/hub/*` and `/api/packages*` routes, which talk to the
// in-process FakeHub and install into temp folders. Nothing between a tool
// and the hub is stubbed, so a field the routes rename, or a refusal they
// reword, fails here (`tools.hub.test.ts` covers the shaping against
// hand-written answers; `server/tests/routes/hub-install.test.ts` the routes).
//
// One story, as an agent lives it: search, read the package, install it,
// see it in the project, read its doc page offline.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import express from 'express';
import fs from 'fs';
import http from 'http';
import net from 'net';
import os from 'os';
import path from 'path';
import { createHubRouter } from '../../server/src/routes/hub.ts';
import { createPackagesRouter } from '../../server/src/routes/packages.ts';
import { HubTransport } from '../../server/src/hub/hub-transport.ts';
import { PackageRoots } from '../../server/src/packages/package-roots.ts';
import { normalizePath } from '../../server/src/normalize-path.ts';
import { readProjectConfig } from '../../server/src/project-config.ts';
import { ArchiveFixture } from '../../server/tests/packages/archive-fixture.ts';
import { FakeHub } from '../../server/tests/fixtures/fake-hub.ts';
import { SearchFixture } from '../../server/tests/fixtures/search-fixture.ts';
import { getHubPackage, installPackage, listPackages, readPackageFile, searchHub } from '../src/tools/hub.ts';
import type { RegistryEntry } from '../src/types.ts';

const ENGINE = ArchiveFixture.ENGINE;
const KIT = '@acme/kit';
const PAGE = '# Standoff\n\nRaises a board off a face.\n';
const ENV_KEYS = ['FLUIDCAD_PACKAGES', 'FLUIDCAD_HOME', 'HOME', 'XDG_CONFIG_HOME', 'APPDATA'] as const;

let hub: FakeHub;
let saved: Record<string, string | undefined>;
let tmp: string;
let project: string;
let engine: http.Server;
let pinnedWorkspace: RegistryEntry;

async function publish(version: string): Promise<void> {
  const files = {
    ...ArchiveFixture.defaultFiles(),
    'standoff.feature.js': `export const standoff = () => '${version}';\n`,
    'docs/standoff.md': PAGE,
    'README.md': `# Kit ${version}\n`,
  };
  await hub.addArchive(await ArchiveFixture.zip({
    version,
    files,
    manifest: {
      features: [{
        id: 'standoff',
        exportName: 'standoff',
        module: 'standoff.feature.js',
        meta: {
          id: 'standoff',
          label: 'Standoff',
          description: 'A boss with a hole',
          call: ['face', { height: 'height' }],
          params: { face: { picker: 'face', label: 'On face' }, height: { type: 'length', label: 'Height', default: 10 } },
        },
      }],
    },
  }));
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

beforeEach(async () => {
  hub.reset();
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  tmp = normalizePath(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-mcp-hub-routes-'))));
  project = path.posix.join(tmp, 'project');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'fluidcad.json'), JSON.stringify({ engine: ENGINE }, null, 2) + '\n');
  fs.writeFileSync(path.join(project, 'init.js'), '');
  process.env.FLUIDCAD_PACKAGES = path.posix.join(tmp, 'library');
  process.env.FLUIDCAD_HOME = path.join(tmp, 'fluidcad-home');
  process.env.HOME = path.join(tmp, 'home');
  process.env.XDG_CONFIG_HOME = path.join(tmp, 'home');
  process.env.APPDATA = path.join(tmp, 'home');
  PackageRoots.forget();

  const app = express();
  app.use(express.json());
  app.use('/api', createPackagesRouter({ workspacePath: project }));
  app.use('/api', createHubRouter({
    workspacePath: project,
    engineVersion: ENGINE,
    sdkVersion: 1,
    env: { FLUIDCAD_HUB_URL: hub.origin },
    transport: new HubTransport({ version: ENGINE, client: 'app', retryDelayMs: 1 }),
  }));
  engine = http.createServer(app);
  await new Promise<void>((resolve) => engine.listen(0, '127.0.0.1', () => resolve()));
  pinnedWorkspace = {
    workspacePath: project,
    port: (engine.address() as net.AddressInfo).port,
    pid: process.pid,
    version: ENGINE,
    startedAt: new Date(0).toISOString(),
  };
});

afterEach(async () => {
  engine.closeAllConnections();
  await new Promise((resolve) => engine.close(resolve));
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

describe('the hub tools against the real engine routes', () => {
  it('search → describe → install → list → read, then the same reads with the hub gone', async () => {
    await publish('0.1.0');
    await publish('0.2.0');
    hub.searchAnswer = SearchFixture.answer([SearchFixture.row({ origin: hub.origin, version: '0.2.0' })]);

    const found = await searchHub({ pinnedWorkspace, query: 'standoff' });
    expect(found.ok).toBe(true);
    if (!found.ok) { return; }
    expect(hub.searchQueries()[0].get('q')).toBe('standoff');
    expect(hub.searchQueries()[0].get('limit')).toBe('10');
    expect(found.data.results[0]).toMatchObject({ name: KIT, version: '0.2.0', publisher: 'acme', installed: [], pinned: null });

    const described = await getHubPackage({ pinnedWorkspace, name: KIT });
    expect(described.ok).toBe(true);
    if (!described.ok) { return; }
    expect(described.data).toMatchObject({ name: KIT, latestVersion: '0.2.0', installVersion: '0.2.0', installed: [] });
    expect(described.data.versions.map((version) => version.version).sort()).toEqual(['0.1.0', '0.2.0']);
    expect(described.data.described).toMatchObject({
      version: '0.2.0',
      import: "import { standoff } from '@acme/kit';",
      docs: ['docs/standoff.md'],
      readme: '# Kit 0.2.0\n',
    });
    expect(described.data.described?.features).toEqual([{
      export: 'standoff',
      id: 'standoff',
      module: 'standoff.feature.js',
      label: 'Standoff',
      description: 'A boss with a hole',
      usage: 'standoff(face, { height })',
      values: { face: { picker: 'face', label: 'On face' }, height: { type: 'length', label: 'Height', default: 10 } },
    }]);

    // Before the install, the doc page comes from the hub.
    const remote = await readPackageFile({ pinnedWorkspace, name: KIT, path: 'docs/standoff.md' });
    expect(remote.ok && remote.data).toMatchObject({ version: '0.2.0', source: 'hub', content: PAGE });

    const installed = await installPackage({ pinnedWorkspace, name: KIT });
    expect(installed.ok).toBe(true);
    if (!installed.ok) { return; }
    expect(installed.data).toMatchObject({
      name: KIT,
      version: '0.2.0',
      source: 'hub',
      status: 'installed',
      target: 'library',
      pin: 'pinned',
      notes: [],
      import: "import { standoff } from '@acme/kit';",
      docs: ['docs/standoff.md'],
      readme: 'README.md',
    });
    expect(installed.data.features[0].usage).toBe('standoff(face, { height })');
    expect(readProjectConfig(project).dependencies?.[KIT]?.version).toBe('0.2.0');

    const again = await installPackage({ pinnedWorkspace, name: KIT });
    expect(again.ok && again.data).toMatchObject({ source: 'installed', status: 'unchanged', pin: 'unchanged' });
    expect(hub.downloadsOf(KIT, '0.2.0')).toHaveLength(1);

    const other = await installPackage({ pinnedWorkspace, name: KIT, version: '0.1.0' });
    expect(other).toMatchObject({ ok: false, code: 'install-refused', details: { statusCode: 409, code: 'version-change' } });
    expect(await installPackage({ pinnedWorkspace, name: 'kit' })).toMatchObject({ ok: false, code: 'install-refused', details: { code: 'no-publisher' } });
    expect(await installPackage({ pinnedWorkspace, name: '@acme/nothing' })).toMatchObject({ ok: false, code: 'not-found' });

    // From here on the hub is gone: what is installed still answers.
    await hub.stop();
    try {
      const listed = await listPackages({ pinnedWorkspace });
      expect(listed.ok && listed.data).toMatchObject({
        uses: [{ name: KIT, version: '0.2.0', installedIn: 'library' }],
        projectCopies: [],
        library: [{ name: KIT, version: '0.2.0', features: 1, parts: 0 }],
      });
      const detail = await listPackages({ pinnedWorkspace, name: KIT });
      expect(detail.ok && detail.data).toMatchObject({
        name: KIT,
        version: '0.2.0',
        usedByProject: true,
        installedIn: 'library',
        import: "import { standoff } from '@acme/kit';",
        docs: ['docs/standoff.md'],
        readme: 'README.md',
      });
      const local = await readPackageFile({ pinnedWorkspace, name: KIT, path: 'docs/standoff.md' });
      expect(local.ok && local.data).toMatchObject({ version: '0.2.0', source: 'installed', content: PAGE });
      expect(await readPackageFile({ pinnedWorkspace, name: KIT, path: 'docs/nothing.md' })).toMatchObject({ ok: false, code: 'not-found' });

      expect(await searchHub({ pinnedWorkspace })).toMatchObject({ ok: false, code: 'hub-unreachable' });
      expect(await getHubPackage({ pinnedWorkspace, name: KIT })).toMatchObject({ ok: false, code: 'hub-unreachable' });
      expect(await installPackage({ pinnedWorkspace, name: '@acme/other' })).toMatchObject({ ok: false, code: 'hub-unreachable' });
    } finally {
      hub = await FakeHub.start();
    }
  });
});
