import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { registryFilePath } from '../src/discovery.ts';
import {
  PackageApi,
  getHubPackage,
  installPackage,
  listPackages,
  readPackageFile,
  searchHub,
} from '../src/tools/hub.ts';
import type { RegistryEntry } from '../src/types.ts';

/**
 * The hub and package tools (docs/agent-hub-plan.md) against a fake engine:
 * what they ask the engine's hub bridge for, how they shape its answers for
 * an agent, and how its refusals become tool errors. The engine's side is
 * `server/tests/routes/hub-install.test.ts`.
 */

const KIT = '@acme/kit';

type Reply = { status?: number; json?: unknown; body?: Buffer | string; contentType?: string };

let fakeHome: string;
let homeSpy: ReturnType<typeof vi.spyOn>;
let server: http.Server | null = null;
let port = 0;
let requests: { method: string; url: string; body: string }[] = [];
/** What the fake engine answers, by `METHOD path` (the query left out); anything else is an Express-like HTML 404. */
let routes: Record<string, Reply | ((url: URL, body: string) => Reply)> = {};

function entry(): RegistryEntry {
  return { workspacePath: '/tmp/ws-hub', port, pid: process.pid, version: '0.0.51', startedAt: '2026-11-18T12:00:00.000Z' };
}

function startEngine(): Promise<number> {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        requests.push({ method: req.method ?? '', url: req.url ?? '', body });
        const url = new URL(req.url ?? '/', 'http://engine');
        const route = routes[`${req.method} ${decodeURIComponent(url.pathname)}`];
        if (!route) {
          res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
          res.end('<!DOCTYPE html><pre>Cannot GET</pre>');
          return;
        }
        const reply = typeof route === 'function' ? route(url, body) : route;
        if (reply.json !== undefined) {
          res.writeHead(reply.status ?? 200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(reply.json));
          return;
        }
        res.writeHead(reply.status ?? 200, { 'content-type': reply.contentType ?? 'text/markdown; charset=utf-8' });
        res.end(reply.body ?? '');
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server!.address();
      resolve(typeof addr === 'object' && addr ? addr.port : 0);
    });
  });
}

/** A manifest as `fluidcad pack` writes one: a feature, a part with params, a generated part, an assembly. */
function manifest(version = '0.2.0') {
  return {
    manifestVersion: 1,
    name: KIT,
    version,
    description: 'Standoffs and plates',
    license: 'MIT',
    unit: 'mm',
    features: [{
      id: 'standoff',
      exportName: 'standoff',
      module: 'features/standoff.feature.js',
      meta: {
        id: 'standoff',
        label: 'Standoff',
        description: 'A boss with a hole',
        icon: './standoff.svg',
        group: 'create',
        kind: 'tool',
        operations: ['add', 'new'],
        defaultOperation: 'add',
        call: ['face', { height: 'height', size: 'size' }],
        params: {
          face: { picker: 'face', label: 'On face', surface: 'planar', description: 'The face it stands on', group: 'Placement' },
          height: { type: 'length', label: 'Height', default: 10, min: 0, description: 'How far it rises', picture: './height.svg' },
          size: { type: 'choice', label: 'Size', default: 'm3', options: [{ label: 'M3', value: 'm3', image: './m3.svg' }, { label: 'M4', value: 'm4' }] },
        },
        layout: [{ row: ['face'] }],
        ghost: true,
        contexts: ['part'],
      },
    }],
    parts: [
      { exportName: 'plateStack', module: 'assemblies/plate-stack.assembly.js', name: 'Plate stack', kind: 'assembly', exportKind: 'value', params: [] },
      {
        exportName: 'pcbPlate',
        module: 'parts/pcb-plate.part.js',
        name: 'PCB plate',
        kind: 'part',
        exportKind: 'value',
        params: [{ label: 'Width', defaultValue: 60, currentValue: 60, controlType: 'number', description: 'Across X', min: 10, group: 'Size' }],
        configurations: [{ name: 'Small', values: { Width: 40 } }],
      },
      { exportName: 'spacer', module: 'parts/spacer.part.js', name: 'Spacer', kind: 'part', exportKind: 'factory', params: [] },
      {
        exportName: 'gearPart',
        module: 'parts/gear.part.js',
        name: 'gearPart',
        kind: 'part',
        exportKind: 'value',
        params: [],
        definitionKind: 'generated',
        schema: {
          kind: 'part',
          definitionKind: 'generated',
          id: 'gear',
          label: 'Gear',
          description: 'A spur gear',
          params: { teeth: { type: 'count', label: 'Teeth', default: 18, min: 6 }, width: { type: 'length', label: 'Width', default: 10 } },
          layout: [],
          connectors: ['axis'],
        },
      },
    ],
    files: ['README.md', 'docs/guide/holes.md', 'docs/standoff.md', 'docs/standoff.svg', 'features/standoff.feature.js', 'index.js'],
  };
}

function searchRow(overrides: Record<string, unknown> = {}) {
  return {
    fullName: KIT,
    name: 'kit',
    scope: 'acme',
    version: '0.2.0',
    description: 'Standoffs\n  and   plates',
    publisher: { handle: 'acme' },
    counts: { features: 4, parts: 2, assemblies: 1 },
    features: [{ id: 'standoff', label: 'Standoff', iconUrl: 'api/hub/files/x.svg' }, { id: 'boss', label: 'Boss', iconUrl: null }],
    moreFeatures: 2,
    installs: 12,
    likes: 3,
    license: 'MIT',
    minEngine: '0.0.46',
    sdkVersion: 1,
    updatedAt: '2026-10-10T00:00:00.000Z',
    compatible: true,
    deprecated: null,
    cardImageUrl: 'api/hub/media/x',
    local: { installed: ['0.1.0'], pinned: '0.1.0', updateAvailable: '0.2.0' },
    ...overrides,
  };
}

function searchAnswer(results: unknown[], overrides: Record<string, unknown> = {}) {
  return { total: results.length, capped: false, page: 1, limit: 10, request: { engine: '0.0.51', sdk: 1 }, facets: {}, results, ...overrides };
}

function packageDetail(overrides: Record<string, unknown> = {}) {
  return {
    name: KIT,
    description: 'Standoffs and plates',
    publisher: 'acme',
    keywords: ['pcb'],
    homepage: null,
    counts: { installs: 12, likes: 3, comments: 0 },
    deprecatedMessage: null,
    latestVersion: '0.2.0',
    compatibility: { engine: '0.0.51', sdk: 1, latestCompatible: true, newestCompatible: '0.2.0' },
    latest: { version: '0.2.0', license: 'MIT' },
    listing: { license: 'MIT', homepageUrl: 'https://acme.example', repositoryUrl: null, deprecatedMessage: null, media: [] },
    versions: [
      { version: '0.2.0', status: 'published', publishedAt: '2026-10-10T00:00:00.000Z', minEngine: '0.0.46', notes: 'Adds the plate.', removed: null },
      { version: '0.1.5', status: 'published', publishedAt: '2026-10-05T00:00:00.000Z', minEngine: '0.0.46', notes: '', removed: { at: 'x', reason: null } },
      { version: '0.1.0', status: 'published', publishedAt: '2026-10-01T00:00:00.000Z', minEngine: '0.0.46', notes: '', removed: null },
    ],
    local: { installed: [], pinned: null, updateAvailable: null },
    ...overrides,
  };
}

function versionDetail(version = '0.2.0', overrides: Record<string, unknown> = {}) {
  return {
    name: KIT,
    version,
    status: 'published',
    isLatest: true,
    minEngine: '0.0.46',
    unit: 'mm',
    publishedAt: '2026-10-10T00:00:00.000Z',
    notes: 'Adds the plate.',
    readmeUrl: `api/hub/files/${KIT}/${version}/README.md`,
    docs: ['docs/guide/holes.md', 'docs/standoff.md'],
    files: manifest(version).files.map((file) => ({ path: file, size: 10 })),
    manifest: { features: manifest(version).features, parts: manifest(version).parts },
    ...overrides,
  };
}

/** `GET /api/packages` with `@acme/kit` in the library at `versions`, pinned at `pinned`. */
function overview(options: { library?: string[]; projectCopies?: string[]; pinned?: string | null; availability?: string } = {}) {
  const installed = (target: string, versions: string[]) => versions.map((version) => ({ name: KIT, version, target, directory: `/lib/${version}`, manifest: manifest(version), bytes: 100 }));
  return {
    library: { path: '/lib', source: 'default', packages: installed('library', options.library ?? []) },
    project: { path: '/ws/packages', packages: installed('project', options.projectCopies ?? []) },
    pins: options.pinned ? [{ name: KIT, version: options.pinned, integrity: 'sha256-x', availability: options.availability ?? 'library', directory: null }] : [],
    updates: options.pinned ? { [KIT]: '0.3.0' } : {},
    updatesFrom: {},
    hubMarks: options.pinned ? { [KIT]: { deprecated: 'Use @acme/kit2.' } } : {},
    problems: [],
  };
}

const UNREACHABLE: Reply = { status: 503, json: { error: "Couldn't reach https://hub.fluidcad.io.", code: 'hub-unreachable', details: { hub: 'https://hub.fluidcad.io', cause: 'network' } } };

beforeEach(async () => {
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-mcp-hub-test-'));
  homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
  requests = [];
  routes = {};
  port = await startEngine();
  const dir = path.dirname(registryFilePath());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(registryFilePath(), JSON.stringify({ schemaVersion: 1, instances: [entry()] }));
});

afterEach(async () => {
  homeSpy.mockRestore();
  fs.rmSync(fakeHome, { recursive: true, force: true });
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
});

describe('PackageApi', () => {
  it('keeps what a call needs and drops what only a dialog needs', () => {
    const api = PackageApi.of(KIT, manifest());
    expect(api.import).toBe("import { standoff, pcbPlate, spacer, gearPart, plateStack } from '@acme/kit';");
    expect(api.features).toEqual([{
      export: 'standoff',
      id: 'standoff',
      module: 'features/standoff.feature.js',
      label: 'Standoff',
      description: 'A boss with a hole',
      kind: 'tool',
      usage: 'standoff(face, { height, size })',
      operations: ['add', 'new'],
      defaultOperation: 'add',
      values: {
        face: { picker: 'face', label: 'On face', surface: 'planar', description: 'The face it stands on' },
        height: { type: 'length', label: 'Height', default: 10, min: 0, description: 'How far it rises' },
        size: { type: 'choice', label: 'Size', default: 'm3', options: [{ label: 'M3', value: 'm3' }, { label: 'M4', value: 'm4' }] },
      },
    }]);
  });

  it('says how each part is inserted: by value, as a factory, generated by id; parts before assemblies', () => {
    const { parts } = PackageApi.of(KIT, manifest());
    expect(parts.map((part) => `${part.kind}:${part.export}`)).toEqual(['part:pcbPlate', 'part:spacer', 'part:gearPart', 'assembly:plateStack']);
    expect(parts[0]).toEqual({
      export: 'pcbPlate',
      name: 'PCB plate',
      kind: 'part',
      module: 'parts/pcb-plate.part.js',
      usage: 'insert(pcbPlate)',
      params: [{ label: 'Width', default: 60, type: 'number', description: 'Across X', min: 10 }],
      configurations: ['Small'],
    });
    expect(parts[1].usage).toBe('insert(spacer())');
    expect(parts[2]).toEqual({
      export: 'gearPart',
      name: 'Gear',
      kind: 'part',
      module: 'parts/gear.part.js',
      usage: 'insert(gearPart, { teeth, width })',
      description: 'A spur gear',
      generated: true,
      values: { teeth: { type: 'count', label: 'Teeth', default: 18, min: 6 }, width: { type: 'length', label: 'Width', default: 10 } },
      connectors: ['axis'],
    });
  });

  it('reads a manifest that is missing or malformed as exporting nothing', () => {
    expect(PackageApi.of(KIT, null)).toEqual({ import: null, features: [], parts: [] });
    expect(PackageApi.of(KIT, { features: [{ id: 1 }, null], parts: 'x' })).toEqual({ import: null, features: [], parts: [] });
  });

  it('finds the doc pages and the README in a file list', () => {
    expect(PackageApi.docs(manifest().files)).toEqual(['docs/guide/holes.md', 'docs/standoff.md']);
    expect(PackageApi.readme(manifest().files)).toBe('README.md');
    expect(PackageApi.readme(['index.js'])).toBeNull();
  });
});

describe('search_hub', () => {
  it("asks the engine's bridge with the hub's parameter names and ten rows by default", async () => {
    routes['GET /api/hub/search'] = { json: searchAnswer([]) };
    await searchHub({ query: '  standoff pcb ', contents: ['features', 'parts'], units: 'metric', license: ['MIT', 'Apache-2.0'], sort: 'installs', order: 'asc', page: 2 });
    const url = new URL(requests[0].url, 'http://engine');
    expect(url.pathname).toBe('/api/hub/search');
    expect(url.searchParams.get('q')).toBe('standoff pcb');
    expect(url.searchParams.getAll('contents')).toEqual(['features', 'parts']);
    expect(url.searchParams.getAll('units')).toEqual(['metric']);
    expect(url.searchParams.getAll('license')).toEqual(['MIT', 'Apache-2.0']);
    expect(url.searchParams.get('sort')).toBe('installs');
    expect(url.searchParams.get('order')).toBe('asc');
    expect(url.searchParams.get('page')).toBe('2');
    expect(url.searchParams.get('limit')).toBe('10');
  });

  it('shapes a row for an agent: no images, the local marks flat, the description on one line', async () => {
    routes['GET /api/hub/search'] = { json: searchAnswer([searchRow()], { total: 31 }) };
    const result = await searchHub({});
    expect(result).toEqual({
      ok: true,
      data: {
        total: 31,
        capped: false,
        page: 1,
        limit: 10,
        more: true,
        results: [{
          name: KIT,
          version: '0.2.0',
          description: 'Standoffs and plates',
          publisher: 'acme',
          contents: { features: 4, parts: 2, assemblies: 1 },
          featureLabels: ['Standoff', 'Boss'],
          moreFeatures: 2,
          installs: 12,
          likes: 3,
          license: 'MIT',
          updatedAt: '2026-10-10T00:00:00.000Z',
          compatible: true,
          installed: ['0.1.0'],
          pinned: '0.1.0',
          updateAvailable: '0.2.0',
        }],
      },
    });
    expect(requests[0].url).not.toContain('q=');
  });

  it("says what a package this FluidCAD can't run needs, and passes a deprecation on", async () => {
    routes['GET /api/hub/search'] = { json: searchAnswer([searchRow({ compatible: false, minEngine: '0.0.99', deprecated: 'Use @acme/kit2.' })]) };
    const result = await searchHub({ query: 'kit' });
    expect(result.ok).toBe(true);
    if (!result.ok) { return; }
    expect(result.data.more).toBe(false);
    expect(result.data.results[0]).toMatchObject({
      compatible: false,
      requires: 'FluidCAD 0.0.99 or newer (feature SDK 1); this FluidCAD is 0.0.51 (feature SDK 1)',
      deprecated: 'Use @acme/kit2.',
    });
  });

  it("maps the engine's refusals: the hub unreachable, the hub's own 400, an engine without the route", async () => {
    routes['GET /api/hub/search'] = UNREACHABLE;
    expect(await searchHub({})).toMatchObject({ ok: false, code: 'hub-unreachable', message: "Couldn't reach https://hub.fluidcad.io.", details: { statusCode: 503, code: 'hub-unreachable' } });
    routes['GET /api/hub/search'] = { status: 400, json: { error: 'sort must be one of relevance, installs.', code: 'validation' } };
    expect(await searchHub({ sort: 'x' })).toMatchObject({ ok: false, code: 'hub-refused', message: 'sort must be one of relevance, installs.', details: { code: 'validation' } });
    delete routes['GET /api/hub/search'];
    const old = await searchHub({});
    expect(old).toMatchObject({ ok: false, code: 'http-error', details: { statusCode: 404 } });
    expect(old.ok === false && old.message).toContain('older than this MCP server');
  });
});

describe('get_hub_package', () => {
  it('describes the version an install would get: the detail, its API, its docs and its README', async () => {
    routes[`GET /api/hub/packages/${KIT}`] = { json: packageDetail() };
    routes[`GET /api/hub/packages/${KIT}/versions/0.2.0`] = { json: versionDetail() };
    routes[`GET /api/hub/files/${KIT}/0.2.0/README.md`] = { body: '# Kit\n\nStandoffs.' };
    const result = await getHubPackage({ name: KIT });
    expect(result.ok).toBe(true);
    if (!result.ok) { return; }
    expect(result.data).toMatchObject({
      name: KIT,
      description: 'Standoffs and plates',
      publisher: 'acme',
      license: 'MIT',
      homepage: 'https://acme.example',
      repository: null,
      keywords: ['pcb'],
      installs: 12,
      likes: 3,
      latestVersion: '0.2.0',
      installVersion: '0.2.0',
      installed: [],
      pinned: null,
      updateAvailable: null,
    });
    expect(result.data).not.toHaveProperty('deprecated');
    // A removed version is not on offer.
    expect(result.data.versions).toEqual([
      { version: '0.2.0', publishedAt: '2026-10-10T00:00:00.000Z', minEngine: '0.0.46', notes: 'Adds the plate.' },
      { version: '0.1.0', publishedAt: '2026-10-01T00:00:00.000Z', minEngine: '0.0.46' },
    ]);
    expect(result.data.described).toMatchObject({
      version: '0.2.0',
      status: 'published',
      isLatest: true,
      unit: 'mm',
      notes: 'Adds the plate.',
      import: "import { standoff, pcbPlate, spacer, gearPart, plateStack } from '@acme/kit';",
      docs: ['docs/guide/holes.md', 'docs/standoff.md'],
      readme: '# Kit\n\nStandoffs.',
    });
    expect(result.data.described?.features[0].usage).toBe('standoff(face, { height, size })');
    expect(result.data.described).not.toHaveProperty('readmeTruncated');
  });

  it('describes the version asked for, cuts a long README, and says when nothing installs on this FluidCAD', async () => {
    routes[`GET /api/hub/packages/${KIT}`] = { json: packageDetail({ deprecatedMessage: 'Use @acme/kit2.', compatibility: { engine: '0.0.51', sdk: 1, latestCompatible: false, newestCompatible: null } }) };
    routes[`GET /api/hub/packages/${KIT}/versions/0.1.0`] = { json: versionDetail('0.1.0', { isLatest: false }) };
    routes[`GET /api/hub/packages/${KIT}/versions/0.2.0`] = { json: versionDetail('0.2.0', { readmeUrl: null, docs: undefined }) };
    routes[`GET /api/hub/files/${KIT}/0.1.0/README.md`] = { body: 'x'.repeat(12_500) };
    const asked = await getHubPackage({ name: KIT, version: '0.1.0' });
    expect(asked.ok).toBe(true);
    if (!asked.ok) { return; }
    expect(asked.data.deprecated).toBe('Use @acme/kit2.');
    expect(asked.data.installVersion).toBeNull();
    expect(asked.data.described).toMatchObject({ version: '0.1.0', isLatest: false, readmeTruncated: true });
    expect(asked.data.described?.readme).toHaveLength(12_000);

    // Nothing runs here: the latest is described, for reading; its docs come from the file list.
    const latest = await getHubPackage({ name: KIT });
    expect(latest.ok && latest.data.described).toMatchObject({ version: '0.2.0', readme: null, docs: ['docs/guide/holes.md', 'docs/standoff.md'] });
  });

  it('answers a package with nothing published without a version, and refuses bad names before any request', async () => {
    routes[`GET /api/hub/packages/${KIT}`] = { json: packageDetail({ latestVersion: null, latest: null, compatibility: null, versions: [] }) };
    const empty = await getHubPackage({ name: KIT });
    expect(empty.ok && empty.data).toMatchObject({ latestVersion: null, installVersion: null, described: null, versions: [] });

    requests = [];
    expect(await getHubPackage({ name: 'kit' })).toMatchObject({ ok: false, code: 'invalid-input' });
    expect(await getHubPackage({ name: '@acme/kit/../x' })).toMatchObject({ ok: false, code: 'invalid-input' });
    expect(await getHubPackage({ name: KIT, version: 'latest' })).toMatchObject({ ok: false, code: 'invalid-input' });
    expect(requests).toEqual([]);
  });

  it('maps an unknown package to not-found and an offline hub to hub-unreachable', async () => {
    routes[`GET /api/hub/packages/${KIT}`] = { status: 404, json: { error: "@acme/kit isn't on https://hub.fluidcad.io.", code: 'not-found' } };
    expect(await getHubPackage({ name: KIT })).toMatchObject({ ok: false, code: 'not-found', message: "@acme/kit isn't on https://hub.fluidcad.io." });
    routes[`GET /api/hub/packages/${KIT}`] = UNREACHABLE;
    expect(await getHubPackage({ name: KIT })).toMatchObject({ ok: false, code: 'hub-unreachable' });
  });
});

describe('install_package', () => {
  it("posts the engine's one-call install and answers what was installed with its API", async () => {
    routes['POST /api/hub/install'] = (_url, body) => ({
      json: {
        name: KIT, version: '0.2.0', source: 'hub', status: 'installed', target: 'library', directory: '/lib/@acme/kit/0.2.0',
        integrity: 'sha256-x', pin: 'pinned', upgradedFrom: null, notes: ['@acme/kit is deprecated: Use @acme/kit2.'], manifest: manifest(), echoed: JSON.parse(body),
      },
    });
    const result = await installPackage({ name: ` ${KIT} ` });
    expect(JSON.parse(requests[0].body)).toEqual({ name: KIT });
    expect(result.ok).toBe(true);
    if (!result.ok) { return; }
    expect(result.data).toMatchObject({
      name: KIT,
      version: '0.2.0',
      source: 'hub',
      status: 'installed',
      target: 'library',
      pin: 'pinned',
      notes: ['@acme/kit is deprecated: Use @acme/kit2.'],
      import: "import { standoff, pcbPlate, spacer, gearPart, plateStack } from '@acme/kit';",
      docs: ['docs/guide/holes.md', 'docs/standoff.md'],
      readme: 'README.md',
    });
    expect(result.data).not.toHaveProperty('upgradedFrom');
    expect(result.data).not.toHaveProperty('directory');
    expect(result.data.features).toHaveLength(1);
    expect(result.data.parts).toHaveLength(4);
  });

  it('passes version, target and upgrade on, and reports the version the project moved from', async () => {
    routes['POST /api/hub/install'] = {
      json: { name: KIT, version: '0.2.0', source: 'installed', status: 'unchanged', target: 'project', pin: 'pinned', upgradedFrom: '0.1.0', notes: [], manifest: manifest() },
    };
    const result = await installPackage({ name: KIT, version: '0.2.0', target: 'project', upgrade: true });
    expect(JSON.parse(requests[0].body)).toEqual({ name: KIT, version: '0.2.0', target: 'project', upgrade: true });
    expect(result.ok && result.data).toMatchObject({ source: 'installed', status: 'unchanged', target: 'project', upgradedFrom: '0.1.0' });
    // `upgrade: false` is the default: not sent.
    await installPackage({ name: KIT, upgrade: false });
    expect(JSON.parse(requests[1].body)).toEqual({ name: KIT });
  });

  it("maps refusals: a pin that would change, a conflict, the hub's own, nothing by that name, the hub unreachable", async () => {
    const refuse = (status: number, code: string, error: string) => { routes['POST /api/hub/install'] = { status, json: { error, code } }; };
    refuse(409, 'version-change', 'This project pins @acme/kit 0.1.0; pinning 0.2.0 instead would change its geometry.');
    expect(await installPackage({ name: KIT, version: '0.2.0' })).toMatchObject({
      ok: false, code: 'install-refused', message: 'This project pins @acme/kit 0.1.0; pinning 0.2.0 instead would change its geometry.', details: { statusCode: 409, code: 'version-change' },
    });
    refuse(409, 'conflict', 'Already in your library with different contents.');
    expect(await installPackage({ name: KIT })).toMatchObject({ ok: false, code: 'install-refused', details: { code: 'conflict' } });
    refuse(400, 'no-publisher', 'Name the publisher: `fluidcad install @<handle>/kit`.');
    expect(await installPackage({ name: 'kit' })).toMatchObject({ ok: false, code: 'install-refused', details: { code: 'no-publisher' } });
    refuse(404, 'not-found', "@acme/kit isn't on the hub.");
    expect(await installPackage({ name: KIT })).toMatchObject({ ok: false, code: 'not-found' });
    routes['POST /api/hub/install'] = UNREACHABLE;
    expect(await installPackage({ name: KIT })).toMatchObject({ ok: false, code: 'hub-unreachable' });
  });

  it('refuses arguments it cannot send before any request', async () => {
    expect(await installPackage({ name: '  ' })).toMatchObject({ ok: false, code: 'invalid-input' });
    expect(await installPackage({ name: KIT, version: '^1.0.0' })).toMatchObject({ ok: false, code: 'invalid-input' });
    expect(await installPackage({ name: KIT, target: 'desktop' as any })).toMatchObject({ ok: false, code: 'invalid-input' });
    expect(await installPackage({ name: KIT, upgrade: 'yes' as any })).toMatchObject({ ok: false, code: 'invalid-input' });
    expect(requests).toEqual([]);
  });
});

describe('list_packages', () => {
  it('lists what the project uses, the project copies and the library', async () => {
    routes['GET /api/packages'] = { json: overview({ library: ['0.1.0', '0.2.0'], projectCopies: ['0.2.0'], pinned: '0.2.0', availability: 'project' }) };
    const result = await listPackages({});
    expect(result).toEqual({
      ok: true,
      data: {
        uses: [{ name: KIT, version: '0.2.0', installedIn: 'project', updateAvailable: '0.3.0', deprecated: 'Use @acme/kit2.' }],
        projectCopies: [{ name: KIT, version: '0.2.0', description: 'Standoffs and plates', features: 1, parts: 4 }],
        library: [
          { name: KIT, version: '0.1.0', description: 'Standoffs and plates', features: 1, parts: 4 },
          { name: KIT, version: '0.2.0', description: 'Standoffs and plates', features: 1, parts: 4 },
        ],
      },
    });
  });

  it('marks a pin installed nowhere as missing, and passes a broken pin map on', async () => {
    routes['GET /api/packages'] = { json: { ...overview({ pinned: '0.2.0', availability: 'missing' }), pinsProblem: 'fluidcad.json "dependencies" must be an object.', project: null } };
    const result = await listPackages({});
    expect(result.ok && result.data).toMatchObject({
      uses: [{ name: KIT, version: '0.2.0', installedIn: 'missing' }],
      usesProblem: 'fluidcad.json "dependencies" must be an object.',
      projectCopies: [],
      library: [],
    });
  });

  it('describes one installed package in full, offline: the version the project uses, else the newest', async () => {
    routes['GET /api/packages'] = { json: overview({ library: ['0.1.0', '0.10.0', '0.2.0'], pinned: '0.2.0' }) };
    const used = await listPackages({ name: KIT });
    expect(used.ok && used.data).toMatchObject({
      name: KIT,
      version: '0.2.0',
      usedByProject: true,
      installedIn: 'library',
      description: 'Standoffs and plates',
      license: 'MIT',
      unit: 'mm',
      otherVersions: ['0.1.0', '0.10.0'],
      import: "import { standoff, pcbPlate, spacer, gearPart, plateStack } from '@acme/kit';",
      docs: ['docs/guide/holes.md', 'docs/standoff.md'],
      readme: 'README.md',
    });
    expect(requests).toHaveLength(1);

    routes['GET /api/packages'] = { json: overview({ library: ['0.1.0', '0.10.0', '0.2.0'], projectCopies: ['0.10.0'] }) };
    const newest = await listPackages({ name: KIT });
    expect(newest.ok && newest.data).toMatchObject({ version: '0.10.0', usedByProject: false, installedIn: 'project' });
    const asked = await listPackages({ name: KIT, version: '0.1.0' });
    expect(asked.ok && asked.data).toMatchObject({ version: '0.1.0', installedIn: 'library' });
  });

  it('answers not-found for a package or version that is not installed, naming what is', async () => {
    routes['GET /api/packages'] = { json: overview({ library: ['0.1.0'] }) };
    expect(await listPackages({ name: '@acme/other' })).toMatchObject({ ok: false, code: 'not-found' });
    const version = await listPackages({ name: KIT, version: '9.0.0' });
    expect(version).toMatchObject({ ok: false, code: 'not-found', details: { installed: ['0.1.0'] } });
    routes['GET /api/packages'] = { json: overview({ pinned: '0.2.0', availability: 'missing' }) };
    const missing = await listPackages({ name: KIT });
    expect(missing.ok === false && missing.message).toContain("The project uses @acme/kit 0.2.0, which isn't installed");
    expect(await listPackages({ version: '1.0.0' })).toMatchObject({ ok: false, code: 'invalid-input' });
    expect(await listPackages({ name: 'kit' })).toMatchObject({ ok: false, code: 'invalid-input' });
  });
});

describe('read_package_file', () => {
  it('reads an installed copy from this machine, never asking the hub', async () => {
    routes['GET /api/packages'] = { json: overview({ library: ['0.1.0', '0.2.0'], pinned: '0.1.0' }) };
    routes[`GET /api/packages/file/${KIT}/0.1.0/docs/standoff.md`] = { json: { name: KIT, version: '0.1.0', path: 'docs/standoff.md', target: 'library', content: '# Standoff' } };
    const result = await readPackageFile({ name: KIT, path: './docs/standoff.md' });
    expect(result).toEqual({ ok: true, data: { name: KIT, version: '0.1.0', path: 'docs/standoff.md', source: 'installed', content: '# Standoff', totalChars: 10, offset: 0 } });
    expect(requests.map((r) => r.url)).toEqual(['/api/packages', `/api/packages/file/${KIT}/0.1.0/docs/standoff.md`]);
  });

  it('falls back to the hub for a version that is not installed, resolving the version an install would get', async () => {
    routes['GET /api/packages'] = { json: overview() };
    routes[`GET /api/hub/packages/${KIT}`] = { json: packageDetail() };
    routes[`GET /api/packages/file/${KIT}/0.2.0/docs/standoff.md`] = { status: 404, json: { error: "@acme/kit 0.2.0 isn't installed here.", code: 'not-installed' } };
    routes[`GET /api/hub/files/${KIT}/0.2.0/docs/standoff.md`] = { body: '# Standoff\n\nFrom the hub.' };
    const result = await readPackageFile({ name: KIT, path: 'docs/standoff.md' });
    expect(result.ok && result.data).toMatchObject({ version: '0.2.0', source: 'hub', content: '# Standoff\n\nFrom the hub.' });

    // An engine from before the installed-file route answers an HTML 404: the hub is asked as well.
    delete routes[`GET /api/packages/file/${KIT}/0.2.0/docs/standoff.md`];
    const older = await readPackageFile({ name: KIT, version: '0.2.0', path: 'docs/standoff.md' });
    expect(older.ok && older.data.source).toBe('hub');
  });

  it('reads a long file in windows', async () => {
    routes[`GET /api/packages/file/${KIT}/0.2.0/README.md`] = { json: { content: 'abcdefghij' } };
    const first = await readPackageFile({ name: KIT, version: '0.2.0', path: 'README.md', maxChars: 4 });
    expect(first.ok && first.data).toMatchObject({ content: 'abcd', totalChars: 10, offset: 0, nextOffset: 4 });
    const last = await readPackageFile({ name: KIT, version: '0.2.0', path: 'README.md', offset: 8, maxChars: 4 });
    expect(last.ok && last.data).toMatchObject({ content: 'ij', offset: 8 });
    expect(last.ok && last.data).not.toHaveProperty('nextOffset');
  });

  it("keeps an installed copy's refusal (no such file, not text) instead of asking the hub", async () => {
    routes[`GET /api/packages/file/${KIT}/0.2.0/docs/nothing.md`] = { status: 404, json: { error: '@acme/kit 0.2.0 has no file "docs/nothing.md".', code: 'not-found' } };
    expect(await readPackageFile({ name: KIT, version: '0.2.0', path: 'docs/nothing.md' })).toMatchObject({ ok: false, code: 'not-found' });
    routes[`GET /api/packages/file/${KIT}/0.2.0/icon.png`] = { status: 415, json: { error: 'icon.png is not a text file.', code: 'not-text' } };
    expect(await readPackageFile({ name: KIT, version: '0.2.0', path: 'icon.png' })).toMatchObject({ ok: false, code: 'hub-refused', details: { code: 'not-text' } });
    expect(requests.some((r) => r.url.startsWith('/api/hub/'))).toBe(false);
  });

  it("refuses a binary file from the hub, and maps the hub's refusals", async () => {
    const notInstalled: Reply = { status: 404, json: { error: 'not installed', code: 'not-installed' } };
    routes[`GET /api/packages/file/${KIT}/0.2.0/icon.png`] = notInstalled;
    routes[`GET /api/hub/files/${KIT}/0.2.0/icon.png`] = { body: Buffer.from([0x89, 0x50, 0, 0]), contentType: 'image/png' };
    expect(await readPackageFile({ name: KIT, version: '0.2.0', path: 'icon.png' })).toMatchObject({ ok: false, code: 'hub-refused', details: { code: 'not-text' } });
    routes[`GET /api/packages/file/${KIT}/0.2.0/README.md`] = notInstalled;
    routes[`GET /api/hub/files/${KIT}/0.2.0/README.md`] = { status: 404, json: { error: 'No such file.', code: 'not-found' } };
    expect(await readPackageFile({ name: KIT, version: '0.2.0', path: 'README.md' })).toMatchObject({ ok: false, code: 'not-found' });
    routes[`GET /api/hub/files/${KIT}/0.2.0/README.md`] = UNREACHABLE;
    expect(await readPackageFile({ name: KIT, version: '0.2.0', path: 'README.md' })).toMatchObject({ ok: false, code: 'hub-unreachable' });
  });

  it('refuses a path that leaves the package, and bad windows, before any request', async () => {
    for (const bad of ['../secret', 'docs/../../x', '/etc/passwd', 'docs\\x.md', '', 'docs//x.md']) {
      expect(await readPackageFile({ name: KIT, version: '0.2.0', path: bad }), bad).toMatchObject({ ok: false, code: 'invalid-input' });
    }
    expect(await readPackageFile({ name: KIT, version: '0.2.0', path: 'README.md', offset: -1 })).toMatchObject({ ok: false, code: 'invalid-input' });
    expect(await readPackageFile({ name: 'kit', path: 'README.md' })).toMatchObject({ ok: false, code: 'invalid-input' });
    expect(requests).toEqual([]);
  });
});
