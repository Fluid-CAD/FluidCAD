import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { FluidCadServer } from '../../src/fluidcad-server/index.ts';
import { LocalSceneHost } from '../../src/host/local-scene-host.ts';
import { ENGINE_PACKAGE_ROOT } from '../../src/host/engine-resolution.ts';
import { PackageResolveError, PackageResolver } from '../../src/packages/resolver.ts';
import type { SceneRenderedData } from '../../src/fluidcad-server/render-types.ts';
import { PackageProject } from './package-project.ts';

// A model imports `@acme/kit` from an installed package directory outside
// the workspace — the user library — and renders it with this repo's
// kernel, the way every editor host's engine does. The package loads inline
// through Vite's module runner like a workspace file: one kernel, its engine
// imports steered to the running engine, its files scanned for blocked
// imports, and re-evaluated on every render. The workspace pins the
// package (Stage P5), installed in a temp library.

const FIXTURES = path.resolve(__dirname, '../fixtures');
const KIT_FIXTURE = path.join(FIXTURES, 'packages/@acme/kit/0.1.0');

/** A rectangle of four pinned lines, as a fully constrained sketch body. */
function rectangle(x: number, y: number, w: number, h: number): string {
  const [a, b, c, d] = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]].map(p => `[${p[0]}, ${p[1]}]`);
  return [
    `  const a = line(${a}, ${b}); const b = line(${b}, ${c}); const c = line(${c}, ${d}); const d = line(${d}, ${a});`,
    `  coincident(a.end(), b.start()); coincident(b.end(), c.start()); coincident(c.end(), d.start()); coincident(d.end(), a.start());`,
    `  fix(a.start(), ${a}); fix(b.start(), ${b}); fix(c.start(), ${c}); fix(d.start(), ${d});`,
  ].join('\n');
}

/**
 * The part model: a 40 × 30 × 5 plate (built-ins) and the package's standoff
 * 12 tall on its top. It imports the package's spacer too, whose `part()`
 * runs when the package module evaluates: the part scene materializes it as
 * a definition the module created (top-level tracking). `probe.js`, a
 * workspace module importing `fluidcad/sdk`, is imported after the package.
 */
const MODEL = [
  `import { standoff, spacer } from '@acme/kit';`,
  `import { Feature } from './probe.js';`,
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
  ``,
].join('\n');

/** The assembly: the workspace plate part, and the package's spacer inserted beside it. */
const ASSEMBLY = [
  `import { insert } from 'fluidcad/core';`,
  `import { spacer } from '@acme/kit';`,
  `import { plate } from './plate.part.js';`,
  ``,
  `insert(plate);`,
  `insert(spacer).translate(60, 0, 0);`,
  ``,
].join('\n');

const PLATE_PART = [
  `import { part, sketch, extrude, line } from 'fluidcad/core';`,
  `import { coincident, fix } from 'fluidcad/constraints';`,
  ``,
  `export const plate = part('Plate', () => {`,
  `  sketch('xy', () => {`,
  rectangle(0, 0, 40, 30),
  `  });`,
  `  extrude(5);`,
  `});`,
  ``,
].join('\n');

const PLATE = 40 * 30 * 5;
const tube = (height: number) => Math.PI * (3 ** 2 - 1.5 ** 2) * height;
/** The spacer: radius 0.25 in, 0.5 in long — in mm³. */
const SPACER = Math.PI * 0.25 ** 2 * 0.5 * 25.4 ** 3;

let project: PackageProject;
let root: string;
let kit: string;
let host: LocalSceneHost | null;
let server: FluidCadServer;

const at = (rel: string) => path.join(root, rel).replace(/\\/g, '/');
const inKit = (rel: string) => path.join(kit, rel).replace(/\\/g, '/');

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** Install `@acme/kit` 0.1.0 into the temp library (after `edit`, if any) and pin it. */
async function pinKit(edit?: (dir: string) => void): Promise<void> {
  const { integrity } = await project.install('@acme/kit', '0.1.0', { edit });
  project.config({ '@acme/kit': { version: '0.1.0', integrity } });
}

/** Pin the kit and boot a host over the workspace. */
async function start(edit?: (dir: string) => void): Promise<void> {
  await pinKit(edit);
  host = new LocalSceneHost();
  server = new FluidCadServer(host);
  await server.init(root);
}

/** Render the part model as its editor's live update does. */
function render(code = MODEL): Promise<SceneRenderedData | null> {
  return server.updateLiveCode(at('model.part.js'), code);
}

type Row = {
  type: string;
  hasError?: boolean;
  errorMessage?: string;
  sceneShapes?: { shapeId: string }[];
  sourceLocation?: { filePath: string; line: number };
};

function rowsOf(data: SceneRenderedData | null): Row[] {
  return data!.result as Row[];
}

function errorsOf(data: SceneRenderedData | null): string[] {
  return rowsOf(data).flatMap(row => row.hasError ? [`${row.type}: ${row.errorMessage}`] : []);
}

/** The volume of every solid `rows` show. */
function volumeOf(rows: Row[]): number {
  return rows
    .flatMap(row => row.sceneShapes ?? [])
    .reduce((sum, shape) => sum + (server.getShapeProperties(shape.shapeId)?.volumeMm3 ?? 0), 0);
}

/** The rows a file's statements made. */
function rowsFrom(data: SceneRenderedData | null, file: string): Row[] {
  return rowsOf(data).filter(row => row.sourceLocation?.filePath === file);
}

/** Run `fn` with the server's own error log silenced: a refused render logs before it throws. */
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    return await fn();
  } finally {
    log.mockRestore();
  }
}

beforeEach(() => {
  // A user library of its own: tests never touch the real one.
  project = new PackageProject('fluidcad-package-modules-');
  root = project.root;
  kit = project.packageDir('@acme/kit', '0.1.0');
  write(at('probe.js'), `export { Feature } from 'fluidcad/sdk';\n`);
  write(at('plate.part.js'), PLATE_PART);
  write(at('model.assembly.js'), ASSEMBLY);
  write(at('model.part.js'), MODEL);
  host = null;
});

afterEach(async () => {
  await host?.server.close();
  project.dispose();
});

describe('the @acme/kit fixture', () => {
  it('carries the JavaScript standoff fixture unchanged', () => {
    expect(fs.readFileSync(path.join(KIT_FIXTURE, 'standoff.feature.js'), 'utf8'))
      .toBe(fs.readFileSync(path.join(FIXTURES, 'custom-features/standoff.feature.js'), 'utf8'));
  });
});

describe('a model importing an installed package', () => {
  it('renders the package\'s standoff on the plate and its spacer beside it, every object without an error', async () => {
    await start();
    const data = await render();
    expect(errorsOf(data)).toEqual([]);
    expect(rowsOf(data).filter(row => row.type === 'acme.standoff')).toHaveLength(1);
    expect(volumeOf(rowsOf(data))).toBeCloseTo(PLATE + tube(12) + SPACER, 3);
  });

  it('inserts the package\'s spacer in an assembly, measured in the package\'s inches', async () => {
    await start();
    const data = await server.processFile(at('model.assembly.js'));
    expect(errorsOf(data)).toEqual([]);
    // The spacer declares no unit(): its file's unit is the one the
    // package root's fluidcad.json names, whatever the workspace runs in.
    const spacerRows = rowsFrom(data, inKit('parts/spacer.part.js'));
    expect(spacerRows.length).toBeGreaterThan(0);
    expect(volumeOf(spacerRows)).toBeCloseTo(SPACER, 3);
    expect(volumeOf(rowsFrom(data, at('plate.part.js')))).toBeCloseTo(PLATE, 3);
  });

  it('attributes the spacer\'s body to its line in the package\'s part file', async () => {
    await start();
    const data = await server.processFile(at('model.assembly.js'));
    const spacer = rowsFrom(data, inKit('parts/spacer.part.js'));
    const definition = spacer.find(row => row.type === 'part');
    const cylinder = spacer.find(row => row.type === 'cylinder');
    expect(definition).toBeDefined();
    expect(cylinder).toBeDefined();
    // Two lines below the part() call, as in the file. (Lines are the
    // loaded module's, offset alike for workspace files; only the distance
    // is the file's own.)
    expect(cylinder!.sourceLocation!.line - definition!.sourceLocation!.line).toBe(2);
  });

  it('re-evaluates the package on every render: the second render still tracks the spacer and builds the standoff', async () => {
    await start();
    const first = await render();
    expect(errorsOf(first)).toEqual([]);
    expect(volumeOf(rowsOf(first))).toBeCloseTo(PLATE + tube(12) + SPACER, 3);

    // Without re-evaluation the package's part() ran once, on the first
    // scene: the second would no longer know the spacer.
    const second = await render(`${MODEL}// a note\n`);
    expect(errorsOf(second)).toEqual([]);
    expect(rowsFrom(second, inKit('parts/spacer.part.js')).length).toBeGreaterThan(0);
    expect(volumeOf(rowsOf(second))).toBeCloseTo(PLATE + tube(12) + SPACER, 3);
  });

  it('loads one kernel when a package file is the first to import an engine subpath', async () => {
    await start();
    // The model never names `fluidcad/sdk`: the package's standoff asks for
    // it first, from the library, where Node resolution finds no engine.
    // probe.js asks for it next, from the workspace.
    const data = await render();
    expect(errorsOf(data)).toEqual([]);
    const pkg = await host!.loadModuleRaw(inKit('standoff.feature.js'));
    const probe = await host!.loadModuleRaw(at('probe.js'));
    expect(pkg.Standoff.prototype).toBeInstanceOf(probe.Feature);
  });

  it('loads the package in a workspace that has its own node_modules/fluidcad', async () => {
    fs.mkdirSync(at('node_modules'), { recursive: true });
    fs.symlinkSync(ENGINE_PACKAGE_ROOT, at('node_modules/fluidcad'), 'junction');
    await start();
    // The workspace's own install stands for its own imports…
    expect(host!.steeredEngineEntry()).toBeNull();
    // …and the package's files, outside it, still reach the engine.
    const data = await render();
    expect(errorsOf(data)).toEqual([]);
    expect(volumeOf(rowsOf(data))).toBeCloseTo(PLATE + tube(12) + SPACER, 3);
  });

  it('refuses a package file that imports a blocked Node module', async () => {
    await start(() => write(inKit('helpers/sizes.js'), [
      `import { readFileSync } from 'fs';`,
      `export const SPACER_RADIUS = 0.25;`,
      `export const SPACER_LENGTH = readFileSync.length;`,
      ``,
    ].join('\n')));
    await expect(quietly(() => render())).rejects.toThrow(/Module "fs" is not allowed in FluidCAD scripts/);
  });

  it('refuses a package the workspace also has in node_modules, where Node would load it past the engine', async () => {
    write(at('node_modules/@acme/kit/package.json'), JSON.stringify({ name: '@acme/kit', version: '0.1.0', type: 'module', main: 'index.js' }));
    write(at('node_modules/@acme/kit/index.js'), `export const standoff = () => {};\nexport const spacer = null;\n`);
    await start();
    await expect(quietly(() => render())).rejects.toThrow(
      `FluidCAD packages never load from node_modules, but a copy of \`@acme/kit\` at ${at('node_modules/@acme/kit')} would shadow the installed package.`,
    );
  });

  it('refuses a node_modules folder of the same name that Node itself could not load', async () => {
    fs.mkdirSync(at('node_modules/@acme/kit'), { recursive: true });
    await start();
    await expect(quietly(() => render())).rejects.toThrow(/FluidCAD packages never load from node_modules/);
  });

  it('keeps the package\'s files out of Vite\'s watcher', async () => {
    await start();
    await render();
    const watched = Object.keys(host!.server.watcher.getWatched()).map(dir => dir.replace(/\\/g, '/'));
    expect(watched.some(dir => dir === kit || dir.startsWith(`${kit}/`))).toBe(false);
  });
});

describe('PackageResolver', () => {
  it('resolves a pinned name to its entry, refuses an unpinned one, and leaves every other specifier alone', async () => {
    await pinKit();
    const resolver = new PackageResolver({ project: root });
    expect(resolver.resolve('@acme/kit', at('model.part.js'))).toMatchObject({
      name: '@acme/kit', version: '0.1.0', directory: kit, entry: inKit('index.js'), target: 'library',
    });
    expect((resolver.resolve('@acme/other', at('model.part.js')) as PackageResolveError).code).toBe('not-pinned');
    for (const specifier of ['fluidcad/sdk', './kit.js', '/abs/kit.js', 'three', '@Acme/kit']) {
      expect(resolver.resolve(specifier, at('model.part.js'))).toBeNull();
    }
  });

  it('refuses a path into a package, which is imported by its name only', async () => {
    await pinKit();
    const resolved = new PackageResolver({ project: root }).resolve('@acme/kit/parts/spacer.part.js', at('model.part.js'));
    expect(resolved).toBeInstanceOf(PackageResolveError);
    expect((resolved as PackageResolveError).code).toBe('subpath');
  });

  it('refuses a name a node_modules folder on the importer\'s way up also holds', async () => {
    await pinKit();
    fs.mkdirSync(at('node_modules/@acme/kit'), { recursive: true });
    const resolver = new PackageResolver({ project: root });
    const resolved = resolver.resolve('@acme/kit', at('parts/deep/model.part.js'));
    expect(resolved).toBeInstanceOf(PackageResolveError);
    expect((resolved as PackageResolveError).code).toBe('node-modules-copy');
    // An importer elsewhere, with no such folder above it, still resolves.
    expect(resolver.resolve('@acme/kit', path.join(project.scratch, 'elsewhere/model.part.js'))).toMatchObject({ entry: inKit('index.js') });
  });

  it('names the package that owns a file, by its directory', async () => {
    await pinKit();
    const resolver = new PackageResolver({ project: root });
    expect(resolver.rootOf(inKit('parts/spacer.part.js'))).toMatchObject({ name: '@acme/kit', version: '0.1.0', directory: kit });
    expect(resolver.rootOf(inKit('index.js'))).toMatchObject({ name: '@acme/kit' });
    expect(resolver.rootOf(`${kit}-fork/index.js`)).toBeNull();
    expect(resolver.rootOf(at('model.part.js'))).toBeNull();
  });
});
