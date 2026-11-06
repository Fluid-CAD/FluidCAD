import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { FluidCadServer } from '../../src/fluidcad-server/index.ts';
import { LocalSceneHost } from '../../src/host/local-scene-host.ts';
import { FeatureCatalog, type FeatureCatalogEntry } from '../../src/feature-catalog/catalog.ts';
import { FeatureScanner } from '../../src/feature-catalog/scan.ts';
import { packPackage } from '../../src/packages/package-builder.ts';
import { PackageArchive } from '../../src/packages/package-archive.ts';
import { PackageOffers } from '../../src/packages/package-offers.ts';
import { PackageRoots } from '../../src/packages/package-roots.ts';
import { ProjectPackages } from '../../src/packages/project-packages.ts';
import { TreeHash } from '../../src/packages/tree-hash.ts';
import type { SceneRenderedData } from '../../src/fluidcad-server/render-types.ts';
import { getFeatureMeta } from '../../../lib/dist/index.js';
import { PackageProject } from './package-project.ts';

/**
 * Feature keys end to end with the real engine (H8c's keys, HD30's names):
 * two publishers' packages share the part after the slash, `@acme/kit` and
 * `@bea-tools/kit`, each with a `standoff`, packed from workspaces named
 * that way and installed in-process under their manifests' names — the
 * second into a library reached through a symbolic link — and a model
 * imports both. The engine keys each package's features by the package
 * (`@acme/kit:standoff`), so nothing collides; the workspace's own keep
 * their plain ids, and a tree installed under HD29 (a manifest name without
 * its scope) keys by where it is installed.
 *
 * Bea's package registers one feature from a plain helper module inside
 * `features/` (`features/helpers/probe.js`, re-exported by
 * `features/probe.feature.js`): the module that defines a class is what
 * decides its package.
 */

const PACKAGE_WORKSPACE = path.resolve(__dirname, '../fixtures/package-workspace');

/** A rectangle of four pinned lines, as a fully constrained sketch body. */
function rectangle(x: number, y: number, w: number, h: number): string {
  const [a, b, c, d] = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]].map(p => `[${p[0]}, ${p[1]}]`);
  return [
    `  const a = line(${a}, ${b}); const b = line(${b}, ${c}); const c = line(${c}, ${d}); const d = line(${d}, ${a});`,
    `  coincident(a.end(), b.start()); coincident(b.end(), c.start()); coincident(c.end(), d.start()); coincident(d.end(), a.start());`,
    `  fix(a.start(), ${a}); fix(b.start(), ${b}); fix(c.start(), ${c}); fix(d.start(), ${d});`,
  ].join('\n');
}

/** A 40 × 30 × 5 plate with the two publishers' standoffs on its top. */
const MODEL = [
  `import { standoff } from '@acme/kit';`,
  `import { standoff as beaStandoff, probe } from '@bea-tools/kit';`,
  `import { sketch, extrude, line, select } from 'fluidcad/core';`,
  `import { coincident, fix } from 'fluidcad/constraints';`,
  `import { face } from 'fluidcad/filters';`,
  ``,
  `sketch('xy', () => {`,
  rectangle(0, 0, 40, 30),
  `});`,
  `extrude(5);`,
  `const top = select(face().planar().onPlane('xy', 5));`,
  `standoff(top, { height: 12 });`,
  `beaStandoff(select(face().planar().onPlane('xy', 0)), { height: 8 });`,
  `probe(4);`,
  ``,
].join('\n');

/** Bea's helper: registers `probe` itself, outside any `*.feature.js`. */
const PROBE_HELPER = [
  `import { Feature, registerBuilder } from 'fluidcad/sdk';`,
  ``,
  `class Probe extends Feature {`,
  `  static id = 'probe';`,
  `  build() {}`,
  `}`,
  ``,
  `export const probe = registerBuilder((context) => (size) => new Probe({ size }).addTo(context), {`,
  `  feature: {`,
  `    class: Probe, label: 'Probe', group: 'modify', kind: 'modifier',`,
  `    params: { size: { type: 'number', default: 1 } }, call: ['size'],`,
  `  },`,
  `});`,
  ``,
].join('\n');

type Row = { type: string; name?: string; hasError?: boolean; errorMessage?: string; fromCache?: boolean };

let project: PackageProject;
let scratch: string;
let acmeArchive: Buffer;
let beaArchive: Buffer;
let beaNext: Buffer;
let host: LocalSceneHost | null = null;

/** The package workspace copied to `dir` and named `name`, packed. */
async function pack(dir: string, name: string, edit: (ws: string) => void = () => {}): Promise<Buffer> {
  fs.cpSync(PACKAGE_WORKSPACE, dir, { recursive: true });
  const config = JSON.parse(fs.readFileSync(path.join(dir, 'fluidcad.json'), 'utf8'));
  config.package.name = name;
  fs.writeFileSync(path.join(dir, 'fluidcad.json'), JSON.stringify(config, null, 2));
  edit(dir);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    return (await packPackage({ workspacePath: dir, fluidcadVersion: '0.0.46' })).zip;
  } finally {
    log.mockRestore();
  }
}

/** Inspect `archive` into the library and install it under its manifest's name, pinned in the project unless told not to. */
async function install(archive: Buffer, pin = true): Promise<string> {
  const inspection = await PackageArchive.inspect(archive, { root: PackageRoots.libraryPath(), engineVersion: '0.0.46' });
  const outcome = await ProjectPackages.installInspected({ token: inspection.token, target: 'library', project: project.root, pin });
  return outcome.name;
}

async function serve(): Promise<FluidCadServer> {
  host = new LocalSceneHost();
  const server = new FluidCadServer(host);
  await server.init(project.root);
  return server;
}

function rowsOf(data: SceneRenderedData | null): Row[] {
  return data!.result as Row[];
}

function errorsOf(data: SceneRenderedData | null): string[] {
  return rowsOf(data).flatMap(row => row.hasError ? [`${row.type}: ${row.errorMessage}`] : []);
}

function catalog(): FeatureCatalog {
  return new FeatureCatalog({
    workspacePath: project.root,
    scan: async (absPath) => ({ file: absPath, features: [], error: `cannot load ${absPath}`, deps: [] }),
    builtIns: async () => ({}),
  });
}

beforeAll(async () => {
  scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fluidcad-package-names-'));
  acmeArchive = await pack(path.join(scratch, 'acme'), '@acme/kit');
  beaArchive = await pack(path.join(scratch, 'bea'), '@bea-tools/kit', (ws) => {
    const standoff = path.join(ws, 'features', 'standoff.feature.js');
    fs.writeFileSync(standoff, fs.readFileSync(standoff, 'utf8').replace("label: 'Standoff',", "label: 'Standoff (Bea)',"));
    fs.mkdirSync(path.join(ws, 'features', 'helpers'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'features', 'helpers', 'probe.js'), PROBE_HELPER);
    fs.writeFileSync(path.join(ws, 'features', 'probe.feature.js'), `export { probe } from './helpers/probe.js';\n`);
  });
  // Bea's next version: the same features, another tree.
  beaNext = await pack(path.join(scratch, 'bea-next'), '@bea-tools/kit', (ws) => {
    fs.cpSync(path.join(scratch, 'bea', 'features'), path.join(ws, 'features'), { recursive: true });
    const config = JSON.parse(fs.readFileSync(path.join(ws, 'fluidcad.json'), 'utf8'));
    config.package.version = '0.2.0';
    fs.writeFileSync(path.join(ws, 'fluidcad.json'), JSON.stringify(config, null, 2));
  });
});

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

afterEach(async () => {
  await host?.server.close();
  host = null;
  project?.dispose();
});

describe('two publishers\' packages of one name', () => {
  async function both(): Promise<FluidCadServer> {
    project = new PackageProject('fluidcad-package-names-');
    // The library is reached through a link: its real path is elsewhere.
    const real = path.join(project.scratch, 'real-library');
    fs.mkdirSync(real);
    fs.rmSync(project.library, { recursive: true, force: true });
    fs.symlinkSync(real, project.library);
    PackageRoots.forget();
    expect(await install(acmeArchive)).toBe('@acme/kit');
    expect(await install(beaArchive)).toBe('@bea-tools/kit');
    project.write('model.part.js', MODEL);
    return serve();
  }

  it('render side by side, each row keyed by its own package, the probe registered from a helper module included', async () => {
    const server = await both();
    const data = await server.updateLiveCode(project.at('model.part.js'), MODEL);
    expect(errorsOf(data)).toEqual([]);
    const custom = rowsOf(data).filter(row => row.type.includes(':')).map(row => row.type);
    expect(custom).toEqual(['@acme/kit:standoff', '@bea-tools/kit:standoff', '@bea-tools/kit:probe']);
    expect(rowsOf(data).filter(row => row.type === 'standoff' || row.type === 'probe')).toEqual([]);
    // The model holds no key: only the public names its imports name.
    expect(fs.readFileSync(project.at('model.part.js'), 'utf8')).not.toMatch(/kit:/);
  });

  it('are both in the catalog, keyed apart, with no shared-id error, and each resolves its own callee, producer, icon and live builder', async () => {
    const server = await both();
    await server.updateLiveCode(project.at('model.part.js'), MODEL);
    const features = catalog();
    const entries = (await features.list())!;
    const ids = entries.map(e => e.id).sort();
    expect(ids).toEqual(['@acme/kit:fastener', '@acme/kit:standoff', '@bea-tools/kit:fastener', '@bea-tools/kit:probe', '@bea-tools/kit:standoff']);
    expect(entries.every(e => e.error === undefined)).toBe(true);
    const byId = (id: string) => entries.find(e => e.id === id)! as FeatureCatalogEntry;
    expect(byId('@bea-tools/kit:standoff').meta).toMatchObject({ id: '@bea-tools/kit:standoff', label: 'Standoff (Bea)' });
    expect(byId('@acme/kit:standoff').meta).toMatchObject({ id: '@acme/kit:standoff', label: 'Standoff' });

    const callees = await features.calleesFor(MODEL, project.at('model.part.js'));
    expect(callees.feature('standoff')?.id).toBe('@acme/kit:standoff');
    expect(callees.feature('beaStandoff')?.id).toBe('@bea-tools/kit:standoff');
    expect(callees.produces('@acme/kit:standoff', 'standoff')).toBe(true);
    expect(callees.produces('@bea-tools/kit:standoff', 'beaStandoff')).toBe(true);
    expect(callees.produces('@acme/kit:standoff', 'beaStandoff')).toBe(false);

    for (const pkg of ['@acme/kit', '@bea-tools/kit']) {
      const icon = await features.asset(`${pkg}:standoff`, './standoff.svg');
      expect('file' in icon && icon.file).toBe(path.join(fs.realpathSync(project.library), ...pkg.split('/'), '0.1.0', 'features', 'standoff.svg'));
    }

    // The builder a ghost constructs the feature from reports the key too.
    const manager = (server as unknown as { sceneManager: Parameters<typeof FeatureScanner.loadBuilder>[1] }).sceneManager;
    for (const id of ['@acme/kit:standoff', '@bea-tools/kit:standoff', '@bea-tools/kit:probe']) {
      const entry = byId(id);
      const builder = await FeatureScanner.loadBuilder(host!, manager, entry.modulePath, entry.exportName!);
      expect(typeof builder).toBe('function');
      expect(getFeatureMeta(builder as Function)?.id).toBe(id);
    }
  });
  it('rebuild only the package whose pin changed: its keys, not the other package\'s', async () => {
    const server = await both();
    await server.updateLiveCode(project.at('model.part.js'), MODEL);
    const cached = await server.updateLiveCode(project.at('model.part.js'), `${MODEL}// note\n`);
    const standoffs = (data: SceneRenderedData | null) => rowsOf(data).filter(row => row.type.endsWith(':standoff')).map(row => [row.type, row.fromCache]);
    expect(standoffs(cached)).toEqual([['@acme/kit:standoff', true], ['@bea-tools/kit:standoff', true]]);

    const inspection = await PackageArchive.inspect(beaNext, { root: PackageRoots.libraryPath(), engineVersion: '0.0.46' });
    await ProjectPackages.installInspected({ token: inspection.token, target: 'library', project: project.root });
    const config = JSON.parse(fs.readFileSync(project.at('fluidcad.json'), 'utf8'));
    config.dependencies['@bea-tools/kit'] = { version: '0.2.0', integrity: inspection.integrity };
    fs.writeFileSync(project.at('fluidcad.json'), JSON.stringify(config, null, 2));

    const switched = await server.updateLiveCode(project.at('model.part.js'), `${MODEL}// note\n`);
    expect(errorsOf(switched)).toEqual([]);
    expect(standoffs(switched)).toEqual([['@acme/kit:standoff', true], ['@bea-tools/kit:standoff', false]]);
  });
});

describe('a tree installed under HD29', () => {
  it('keeps loading: its manifest names no scope, and its features key by where it is installed', async () => {
    project = new PackageProject('fluidcad-package-hd29-');
    // What an HD29 install left: the tree at <library>/@acme/kit/0.1.0, its
    // manifest saying "kit", pinned with its own tree hash.
    const inspection = await PackageArchive.inspect(acmeArchive, { root: PackageRoots.libraryPath(), engineVersion: '0.0.46' });
    const installed = await ProjectPackages.installInspected({ token: inspection.token, target: 'library', project: project.root });
    const manifestPath = path.join(installed.directory, 'manifest.json');
    PackageProject.chmodFiles(installed.directory, 0o644);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.name = 'kit';
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    const integrity = await TreeHash.ofDirectory(installed.directory);
    PackageProject.chmodFiles(installed.directory, 0o444);
    project.config({ '@acme/kit': { version: '0.1.0', integrity } });

    const model = MODEL
      .replace(`import { standoff as beaStandoff, probe } from '@bea-tools/kit';\n`, '')
      .replace(`beaStandoff(select(face().planar().onPlane('xy', 0)), { height: 8 });\n`, '')
      .replace(`probe(4);\n`, '');
    project.write('model.part.js', model);
    const server = await serve();
    const data = await server.updateLiveCode(project.at('model.part.js'), model);
    expect(errorsOf(data)).toEqual([]);
    expect(rowsOf(data).filter(row => row.type.includes(':')).map(row => row.type)).toEqual(['@acme/kit:standoff']);
  });
});

describe('the library\'s offers in an author\'s workspace', () => {
  it('leave out only the workspace\'s own package, by its exact name: another publisher\'s @…/kit is offered', async () => {
    project = new PackageProject('fluidcad-package-offers-');
    fs.cpSync(PACKAGE_WORKSPACE, project.root, { recursive: true });
    expect(JSON.parse(fs.readFileSync(project.at('fluidcad.json'), 'utf8')).package.name).toBe('@acme/kit');
    await install(acmeArchive, false);
    await install(beaArchive, false);
    expect(PackageRoots.installedAt(project.library).map(location => location.name).sort()).toEqual(['@acme/kit', '@bea-tools/kit']);

    const offers = PackageOffers.of(project.root);
    expect(offers.map(offer => offer.name)).toEqual(['@bea-tools/kit']);
    expect(offers[0].manifest.features.map(feature => feature.id).sort()).toEqual(['fastener', 'probe', 'standoff']);
  });
});

describe('the author\'s own workspace', () => {
  it('keeps its features\' plain ids', async () => {
    project = new PackageProject('fluidcad-package-author-');
    fs.cpSync(PACKAGE_WORKSPACE, project.root, { recursive: true });
    const model = MODEL
      .replace(`import { standoff } from '@acme/kit';`, `import { standoff } from './features/standoff.feature.js';`)
      .replace(`import { standoff as beaStandoff, probe } from '@bea-tools/kit';\n`, '')
      .replace(`beaStandoff(select(face().planar().onPlane('xy', 0)), { height: 8 });\n`, '')
      .replace(`probe(4);\n`, '');
    project.write('model.part.js', model);
    const server = await serve();
    const data = await server.updateLiveCode(project.at('model.part.js'), model);
    expect(errorsOf(data)).toEqual([]);
    expect(rowsOf(data).some(row => row.type === 'standoff')).toBe(true);
    expect(rowsOf(data).some(row => row.type.includes(':'))).toBe(false);
  });
});
