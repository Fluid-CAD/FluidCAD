import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { FluidCadServer } from '../../src/fluidcad-server/index.ts';
import { LocalSceneHost } from '../../src/host/local-scene-host.ts';
import { PackagePins } from '../../src/packages/package-pins.ts';
import { PackageProject } from './package-project.ts';
import type { SceneRenderedData } from '../../src/fluidcad-server/render-types.ts';

// Stage P5: a project's pins decide what `@scope/name` loads, on every
// render, with no restart. The project pins `@acme/kit` in its
// `fluidcad.json` (version + tree hash) and the package sits in a temp
// user library (or the project's own `packages/` copy); every refusal is
// the module's error, worded as in research §3.

/** A rectangle of four pinned lines, as a fully constrained sketch body. */
function rectangle(x: number, y: number, w: number, h: number): string {
  const [a, b, c, d] = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]].map(p => `[${p[0]}, ${p[1]}]`);
  return [
    `  const a = line(${a}, ${b}); const b = line(${b}, ${c}); const c = line(${c}, ${d}); const d = line(${d}, ${a});`,
    `  coincident(a.end(), b.start()); coincident(b.end(), c.start()); coincident(c.end(), d.start()); coincident(d.end(), a.start());`,
    `  fix(a.start(), ${a}); fix(b.start(), ${b}); fix(c.start(), ${c}); fix(d.start(), ${d});`,
  ].join('\n');
}

/** A 40 × 30 × 5 plate with the package's standoff 12 tall on top; the kit's spacer, which the part file does not declare, stays unbuilt. */
const MODEL = [
  `import { standoff } from '@acme/kit';`,
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

/** The kit's spacer inserted in an assembly, beside nothing else. */
const ASSEMBLY = [
  `import { insert } from 'fluidcad/core';`,
  `import { spacer } from '@acme/kit';`,
  ``,
  `insert(spacer);`,
  ``,
].join('\n');

const PLATE = 40 * 30 * 5;
const tube = (height: number) => Math.PI * (3 ** 2 - 1.5 ** 2) * height;
/** The spacer: radius 0.25 in, 0.5 in long — in mm³. */
const SPACER = Math.PI * 0.25 ** 2 * 0.5 * 25.4 ** 3;

type Row = {
  id: string;
  type: string;
  fromCache?: boolean;
  hasError?: boolean;
  errorMessage?: string;
  sceneShapes?: { shapeId: string }[];
  sourceLocation?: { filePath: string; line: number };
  package?: { name: string; version: string };
};

let project: PackageProject;
let host: LocalSceneHost | null;
let server: FluidCadServer;
let pins: Record<string, { version: string; integrity: string }>;

async function boot(): Promise<void> {
  host = new LocalSceneHost();
  server = new FluidCadServer(host);
  await server.init(project.root);
}

/** Install a kit version into the library and pin it. */
async function pinKit(version = '0.1.0', options: Parameters<PackageProject['install']>[2] = {}): Promise<string> {
  const { dir, integrity } = await project.install('@acme/kit', version, options);
  pins = { '@acme/kit': { version, integrity } };
  project.config(pins);
  return dir;
}

function render(code = MODEL): Promise<SceneRenderedData | null> {
  return server.updateLiveCode(project.at('model.part.js'), code);
}

const rowsOf = (data: SceneRenderedData | null): Row[] => data!.result as Row[];
const errorsOf = (data: SceneRenderedData | null): string[] =>
  rowsOf(data).flatMap(row => row.hasError ? [`${row.type}: ${row.errorMessage}`] : []);
const volumeOf = (rows: Row[]): number => rows
  .flatMap(row => row.sceneShapes ?? [])
  .reduce((sum, shape) => sum + (server.getShapeProperties(shape.shapeId)?.volumeMm3 ?? 0), 0);
const standoffOf = (data: SceneRenderedData | null): Row => rowsOf(data).find(row => row.type === 'acme.standoff')!;

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
  project = new PackageProject('fluidcad-package-pins-');
  project.write('model.part.js', MODEL);
  project.write('model.assembly.js', ASSEMBLY);
  host = null;
});

afterEach(async () => {
  await host?.server.close();
  project.dispose();
});

describe('a project\'s pins decide what @acme/kit loads', () => {
  it('renders the pinned 0.1.0 from the library, every object without an error', async () => {
    const kit = await pinKit();
    await boot();
    const data = await render();
    expect(errorsOf(data)).toEqual([]);
    expect(volumeOf(rowsOf(data))).toBeCloseTo(PLATE + tube(12), 3);
    expect(rowsOf(data).filter(row => row.sourceLocation?.filePath === `${kit}/parts/spacer.part.js`)).toEqual([]);
    expect(host!.resolvedPackages()).toMatchObject([{ name: '@acme/kit', version: '0.1.0', target: 'library', directory: kit }]);
    expect(server.getPackageProblems()).toEqual([]);
  });

  it('marks the rows a package file made with the package, and no other row', async () => {
    const kit = await pinKit();
    await boot();
    // The spacer builds where it is inserted: in the assembly.
    const assembly = await server.processFile(project.at('model.assembly.js'));
    expect(errorsOf(assembly)).toEqual([]);
    const spacerRows = rowsOf(assembly).filter(row => row.sourceLocation?.filePath === `${kit}/parts/spacer.part.js`);
    expect(spacerRows.map(row => row.type)).toEqual(expect.arrayContaining(['part', 'cylinder']));
    for (const row of spacerRows) {
      expect(row.package).toEqual({ name: '@acme/kit', version: '0.1.0' });
    }
    const rows = rowsOf(await render());
    // The standoff statement is the model's own line: its row is editable.
    expect(standoffOf({ result: rows } as SceneRenderedData).package).toBeUndefined();
    expect(rows.filter(row => row.sourceLocation?.filePath === project.at('model.part.js')).every(row => row.package === undefined)).toBe(true);
  });

  it('refuses a package the project does not pin', async () => {
    await pinKit();
    project.config(null);
    await boot();
    await expect(quietly(() => render())).rejects.toThrow(
      '`@acme/kit` is not a dependency of this project — install it or add it from your library.',
    );
    expect(server.getPackageProblems()).toEqual([expect.objectContaining({ code: 'not-pinned', name: '@acme/kit', version: null })]);
  });

  it('reports a pinned package missing from both roots, as the render\'s error and as a project problem', async () => {
    const kit = await pinKit();
    await boot();
    expect(errorsOf(await render())).toEqual([]);

    PackageProject.chmodFiles(kit, 0o644);
    fs.rmSync(kit, { recursive: true, force: true });
    const sentence = 'This project uses `@acme/kit` 0.1.0, which isn\'t installed.';
    await expect(quietly(() => render(`${MODEL}// again\n`))).rejects.toThrow(sentence);
    expect(server.getPackageProblems()).toEqual([{ code: 'missing', name: '@acme/kit', version: '0.1.0', message: sentence }]);
    expect(PackagePins.problems(project.root)).toEqual([{ code: 'missing', name: '@acme/kit', version: '0.1.0', message: sentence }]);
    expect(PackagePins.describeProblems(project.root)).toEqual([
      `FluidCAD: ${sentence} \`fluidcad install @acme/kit@0.1.0\` downloads it from the hub (\`fluidcad install\` alone fetches every missing one), or install it from a file.`,
    ]);

    // Put back, it renders again with no restart.
    await pinKit();
    expect(errorsOf(await render(`${MODEL}// back\n`))).toEqual([]);
    expect(PackagePins.problems(project.root)).toEqual([]);
  });

  it('refuses an installed tree whose files changed under the pin', async () => {
    const kit = await pinKit();
    await boot();
    expect(errorsOf(await render())).toEqual([]);

    // One byte, with the installer's read-only bit lifted.
    const file = `${kit}/helpers/sizes.js`;
    fs.chmodSync(file, 0o644);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('0.25', '0.26'));
    await expect(quietly(() => render(`${MODEL}// again\n`))).rejects.toThrow(
      'The installed `@acme/kit` 0.1.0 differs from the one this project was built with.',
    );
    expect(server.getPackageProblems()).toEqual([expect.objectContaining({ code: 'integrity', version: '0.1.0' })]);
  });

  it('refuses a package that needs a newer engine', async () => {
    await pinKit('0.1.0', { edit: (dir) => PackagePinsTest.editManifest(dir, { minEngine: '99.0.0' }) });
    await boot();
    await expect(quietly(() => render())).rejects.toThrow(
      /^`@acme\/kit` 0\.1\.0 needs FluidCAD 99\.0\.0 or newer; this engine is \d+\.\d+\.\d+\./,
    );
  });

  it('refuses a package built against another feature SDK', async () => {
    await pinKit('0.1.0', { edit: (dir) => PackagePinsTest.editManifest(dir, { sdkVersion: 2 }) });
    await boot();
    await expect(quietly(() => render())).rejects.toThrow(
      '`@acme/kit` 0.1.0 was built against feature SDK version 2; this engine has version 1.',
    );
  });

  it('switches to the pinned 0.2.0 with no restart, rebuilding its standoff instead of serving 0.1.0 from the cache', async () => {
    await pinKit('0.1.0');
    await boot();
    const first = await render();
    expect(errorsOf(first)).toEqual([]);
    expect(volumeOf(rowsOf(first))).toBeCloseTo(PLATE + tube(12), 3);
    // Unchanged pins: the standoff comes from the cache.
    const again = await render(`${MODEL}// note\n`);
    expect(standoffOf(again).fromCache).toBe(true);

    await pinKit('0.2.0');
    // The same code: only fluidcad.json changed.
    const switched = await render(`${MODEL}// note\n`);
    expect(errorsOf(switched)).toEqual([]);
    expect(standoffOf(switched).fromCache).toBe(false);
    expect(volumeOf(rowsOf(switched))).toBeCloseTo(PLATE + tube(17), 3);
    expect(host!.resolvedPackages()).toMatchObject([{ name: '@acme/kit', version: '0.2.0' }]);

    // And caches again from there.
    const settled = await render(`${MODEL}// note 2\n`);
    expect(standoffOf(settled).fromCache).toBe(true);
    expect(volumeOf(rowsOf(settled))).toBeCloseTo(PLATE + tube(17), 3);
  });

  it('loads the project\'s own copy before the library\'s', async () => {
    await pinKit();
    const copy = (await project.install('@acme/kit', '0.1.0', { target: 'project' })).dir;
    await boot();
    const data = await server.processFile(project.at('model.assembly.js'));
    expect(errorsOf(data)).toEqual([]);
    expect(host!.resolvedPackages()).toMatchObject([{ target: 'project', directory: copy }]);
    const spacer = rowsOf(data).find(row => row.type === 'part')!;
    expect(spacer.sourceLocation!.filePath).toBe(`${copy}/parts/spacer.part.js`);
    expect(spacer.package).toEqual({ name: '@acme/kit', version: '0.1.0' });
  });

  it('gives a package part the package\'s own material, never the project\'s same-named one', async () => {
    const { integrity } = await project.install('@acme/kit', '0.1.0');
    // The project defines its own `acme-pom`, five times denser.
    project.config({ '@acme/kit': { version: '0.1.0', integrity } }, { materials: { 'acme-pom': { name: 'Project POM', density: 7.05 } } });
    await boot();
    const data = await server.processFile(project.at('model.assembly.js'));
    expect(errorsOf(data)).toEqual([]);
    expect(data!.objectWarnings).toEqual([]);
    const part = rowsOf(data).find(row => row.type === 'part')!;
    const properties = server.getPartProperties(part.id)!;
    expect(properties.material).toMatchObject({ id: 'acme-pom', name: 'Acme POM', density: 1.41 });
    expect(properties.volumeMm3).toBeCloseTo(SPACER, 3);
    expect(properties.massG).toBeCloseTo(SPACER / 1000 * 1.41, 6);
  });

  it('warns about a package part\'s material its own package lacks, even when the project has it', async () => {
    const { integrity } = await project.install('@acme/kit', '0.1.0', {
      edit: (dir) => fs.writeFileSync(path.join(dir, 'fluidcad.json'), JSON.stringify({ unit: 'in' })),
    });
    project.config({ '@acme/kit': { version: '0.1.0', integrity } }, { materials: { 'acme-pom': { name: 'Project POM', density: 7.05 } } });
    await boot();
    const data = await server.processFile(project.at('model.assembly.js'));
    expect(errorsOf(data)).toEqual([]);
    expect(data!.objectWarnings.map(warning => warning.message)).toEqual(['Unknown material: acme-pom']);
    const part = rowsOf(data).find(row => row.type === 'part')!;
    expect(server.getPartProperties(part.id)!.massG).toBeUndefined();
  });
});

/** Test-only edits of an installed copy, made before it is hashed and pinned. */
class PackagePinsTest {
  static editManifest(dir: string, fields: Record<string, unknown>): void {
    const file = path.join(dir, 'manifest.json');
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), ...fields }, null, 2));
  }
}
