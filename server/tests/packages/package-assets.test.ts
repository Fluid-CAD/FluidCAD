import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { FluidCadServer } from '../../src/fluidcad-server/index.ts';
import { LocalSceneHost } from '../../src/host/local-scene-host.ts';
import { collectEntryFiles } from '../../src/files/entry-files.ts';
import { PackageAssetRoots } from '../../src/packages/package-asset-roots.ts';
import type { SceneRenderedData } from '../../src/fluidcad-server/render-types.ts';
import { PackageProject } from './package-project.ts';
import { twoFontFiles, type FontFile } from '../../../lib/tests/helpers/font-files.ts';

// An installed package's load() and .font() read the package's own files —
// its imports/ and fonts/, which pack ships — and the project's own calls
// read the project's, decided by the file that wrote the call
// (`PackageAssetRoots`, installed when the server roots the engine). A
// package part that takes a file name from the model using it reads that
// name in the project with `{ from: 'project' }`. A package's missing file
// fails naming the package; the project's file of that name is never read
// instead.
//
// `@acme/kit` 0.1.0 (the fixture, an inch package) gains a motor part that
// loads `motor.step`, shipping its own imports/motor.* (the spacer fixture,
// a cylinder), while the project's imports/motor.* hold a ball.

const IMPORTED_STEP = path.resolve(__dirname, '../fixtures/imported-step');
/** The spacer fixture's volume, mm³ (a cylinder) — the package's motor. */
const SPACER = 11612.262007;
/** The ball fixture's volume, mm³ (a sphere of radius 6) — the project's motor. */
const BALL = (4 / 3) * Math.PI * 6 ** 3;

const KIT = '@acme/kit';
const VERSION = '0.1.0';

/** The package's added parts, each in a file of its own. */
const KIT_PARTS: Record<string, string> = {
  'parts/motor.part.js': [
    `import { part, load } from 'fluidcad/core';`,
    ``,
    `export const motor = part('Motor', () => {`,
    `  load('motor.step');`,
    `});`,
    ``,
  ].join('\n'),
  // Its own import is missing: only the project has a `mine`.
  'parts/borrowed.part.js': [
    `import { part, load } from 'fluidcad/core';`,
    ``,
    `export const borrowed = part('Borrowed', () => {`,
    `  load('mine.step');`,
    `});`,
    ``,
  ].join('\n'),
  // A font file name the model using the package passes in, read in the project.
  'parts/badge.part.js': [
    `import { part, param, sketch, text, extrude } from 'fluidcad/core';`,
    ``,
    `export const badge = part('Badge', () => {`,
    `  const font = param('Font', 'fonts/brand.ttf', 'text');`,
    `  sketch('xy', () => {`,
    `    text('A').size(0.5).font(font, { from: 'project' });`,
    `  });`,
    `  extrude(0.1);`,
    `});`,
    ``,
  ].join('\n'),
  // The same name passed in, read without { from }: in the package, which ships no such font.
  'parts/plaque.part.js': [
    `import { part, param, sketch, text, extrude } from 'fluidcad/core';`,
    ``,
    `export const plaque = part('Plaque', () => {`,
    `  const font = param('Font', 'fonts/brand.ttf', 'text');`,
    `  sketch('xy', () => {`,
    `    text('A').size(0.5).font(font);`,
    `  });`,
    `  extrude(0.1);`,
    `});`,
    ``,
  ].join('\n'),
};

const KIT_EXPORTS = [
  `export { motor } from './parts/motor.part.js';`,
  `export { borrowed } from './parts/borrowed.part.js';`,
  `export { badge } from './parts/badge.part.js';`,
  `export { plaque } from './parts/plaque.part.js';`,
  ``,
].join('\n');

let project: PackageProject;
let host: LocalSceneHost | null;
let server: FluidCadServer;
let fonts: [FontFile, FontFile] | null = null;

type Row = {
  type: string;
  hasError?: boolean;
  errorMessage?: string;
  sceneShapes?: { shapeId: string }[];
  sourceLocation?: { filePath: string; line: number };
};

/** `imports/<name>.*` copied from the fixture `<fixture>.*` under `dir`. */
function importStep(dir: string, name: string, fixture: 'spacer' | 'ball'): void {
  fs.mkdirSync(path.join(dir, 'imports'), { recursive: true });
  for (const suffix of ['.brep', '.colors.json', '.import.json']) {
    fs.copyFileSync(path.join(IMPORTED_STEP, `${fixture}${suffix}`), path.join(dir, 'imports', `${name}${suffix}`));
  }
}

/** Add the motor and the font parts to the package copy at `dir`, with its own imports/motor.*. */
function addKitParts(dir: string): void {
  for (const [rel, content] of Object.entries(KIT_PARTS)) {
    fs.writeFileSync(path.join(dir, rel), content);
  }
  fs.appendFileSync(path.join(dir, 'index.js'), KIT_EXPORTS);
  importStep(dir, 'motor', 'spacer');
}

/** Install the kit into `target` (after `edit`), pin it, and boot a server over the project. */
async function start(target: 'library' | 'project', edit?: (dir: string) => void): Promise<string> {
  const { dir, integrity } = await project.install(KIT, VERSION, {
    target,
    edit: (copy) => {
      addKitParts(copy);
      edit?.(copy);
    },
  });
  project.config({ [KIT]: { version: VERSION, integrity } });
  host = new LocalSceneHost(undefined, { linkEngine: false });
  server = new FluidCadServer(host);
  await server.init(project.root);
  return dir;
}

/** Write the project's assembly inserting `lines` and render it. */
async function renderAssembly(imports: string, lines: string): Promise<SceneRenderedData | null> {
  project.write('rig.assembly.js', [
    `import { insert } from 'fluidcad/core';`,
    imports,
    ``,
    lines,
    ``,
  ].join('\n'));
  return quietly(() => server.processFile(project.at('rig.assembly.js')));
}

function rowsOf(data: SceneRenderedData | null): Row[] {
  expect(data).not.toBeNull();
  return data!.result as Row[];
}

function errorsOf(data: SceneRenderedData | null): string[] {
  return rowsOf(data).flatMap((row) => (row.hasError ? [`${row.type}: ${row.errorMessage}`] : []));
}

function rowsFrom(data: SceneRenderedData | null, file: string): Row[] {
  return rowsOf(data).filter((row) => row.sourceLocation?.filePath === file);
}

function volumeOf(rows: Row[]): number {
  return rows
    .flatMap((row) => row.sceneShapes ?? [])
    .reduce((sum, shape) => sum + (server.getShapeProperties(shape.shapeId)?.volumeMm3 ?? 0), 0);
}

async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    return await fn();
  } finally {
    log.mockRestore();
    warn.mockRestore();
  }
}

beforeAll(async () => {
  fonts = await twoFontFiles();
});

beforeEach(() => {
  project = new PackageProject('fluidcad-package-assets-');
  host = null;
  // The project's own motor is a ball, and only the project has a `mine`.
  importStep(project.root, 'motor', 'ball');
  importStep(project.root, 'mine', 'ball');
  project.write('own.part.js', [
    `import { part, load } from 'fluidcad/core';`,
    ``,
    `export const own = part('Own', () => {`,
    `  load('motor.step');`,
    `});`,
    ``,
  ].join('\n'));
  if (fonts) {
    fs.mkdirSync(project.at('fonts'), { recursive: true });
    fs.copyFileSync(fonts[0].path, project.at('fonts/brand.ttf'));
  }
});

afterEach(async () => {
  await host?.server.close();
  project.dispose();
});

describe.each(['project', 'library'] as const)('a %s copy of a package whose part loads its own imported STEP', (target) => {
  it('renders the package\'s motor from its own imports/ and the project\'s from the project\'s, no object in error', async () => {
    const dir = await start(target);
    const data = await renderAssembly(
      `import { motor } from '${KIT}';\nimport { own } from './own.part.js';`,
      `insert(motor);\ninsert(own).translate(50, 0, 0);`,
    );

    expect(errorsOf(data)).toEqual([]);
    const motorRows = rowsFrom(data, `${dir}/parts/motor.part.js`);
    expect(motorRows.some((row) => row.type === 'load')).toBe(true);
    expect(volumeOf(motorRows)).toBeCloseTo(SPACER, 2);
    expect(volumeOf(rowsFrom(data, project.at('own.part.js')))).toBeCloseTo(BALL, 2);
  });

  it('notes the package\'s files as the render\'s inputs, by their path in the package', async () => {
    const dir = await start(target);
    await renderAssembly(`import { motor } from '${KIT}';`, `insert(motor);`);

    expect(server.getRenderAssets()).toEqual(expect.arrayContaining(
      ['motor.brep', 'motor.colors.json', 'motor.import.json'].map((name) => path.join(dir, 'imports', name)),
    ));
    expect(server.getRenderAssets().some((file) => file.startsWith(project.at('imports/')))).toBe(false);
  });

  it('fails the package\'s missing asset naming the package, never reading the project\'s file of that name', async () => {
    const dir = await start(target);
    const data = await renderAssembly(`import { borrowed } from '${KIT}';`, `insert(borrowed);`);

    expect(errorsOf(data)).toEqual([
      "load: Imported asset not found: imports/mine.brep in @acme/kit@0.1.0. " +
        "If the name comes from the model using the package, read it with load(name, { from: 'project' }).",
    ]);
    expect(volumeOf(rowsFrom(data, `${dir}/parts/borrowed.part.js`))).toBe(0);
  });
});

describe('a package part that takes a font file name from the model using it', () => {
  it('reads the name in the project with { from: \'project\' }', async () => {
    if (!fonts) {
      return; // no two .ttf families on this machine to copy; skip
    }
    await start('project');
    const data = await renderAssembly(`import { badge } from '${KIT}';`, `insert(badge, { Font: 'fonts/brand.ttf' });`);

    expect(errorsOf(data)).toEqual([]);
    expect(server.getRenderAssets()).toContain(project.at('fonts/brand.ttf'));
  });

  it('reads it in the package without { from }, and fails naming the package and pointing to { from: \'project\' }', async () => {
    if (!fonts) {
      return; // no two .ttf families on this machine to copy; skip
    }
    await start('library');
    const data = await renderAssembly(`import { plaque } from '${KIT}';`, `insert(plaque, { Font: 'fonts/brand.ttf' });`);

    expect(errorsOf(data)).toContain(
      "text: Font file not found: fonts/brand.ttf in @acme/kit@0.1.0. " +
        "If the name comes from the model using the package, read it with .font(name, { from: 'project' }).",
    );
  });

  it('reads the package\'s own font file without { from } when the package ships one', async () => {
    if (!fonts) {
      return; // no two .ttf families on this machine to copy; skip
    }
    const dir = await start('library', (copy) => {
      fs.mkdirSync(path.join(copy, 'fonts'), { recursive: true });
      fs.copyFileSync(fonts![1].path, path.join(copy, 'fonts', 'brand.ttf'));
    });
    const data = await renderAssembly(`import { plaque } from '${KIT}';`, `insert(plaque);`);

    expect(errorsOf(data)).toEqual([]);
    expect(server.getRenderAssets()).toContain(path.join(dir, 'fonts', 'brand.ttf'));
    expect(server.getRenderAssets()).not.toContain(project.at('fonts/brand.ttf'));
  });
});

describe('a project copy\'s asset changed on disk', () => {
  it('leaves the render that read it behind', async () => {
    const dir = await start('project');
    const data = await renderAssembly(`import { motor } from '${KIT}';`, `insert(motor);`);
    expect(errorsOf(data)).toEqual([]);
    const brep = path.join(dir, 'imports', 'motor.brep');
    expect(server.isRenderBehind(brep)).toBe(false);

    fs.chmodSync(brep, 0o644);
    fs.copyFileSync(path.join(IMPORTED_STEP, 'ball.brep'), brep);

    expect(server.isRenderBehind(brep)).toBe(true);
  });
});

describe('sharing a model that reads a project copy\'s file by its path', () => {
  it('is refused: a link carries no file of an installed package', async () => {
    if (!fonts) {
      return; // no two .ttf families on this machine to copy; skip
    }
    await start('project', (copy) => {
      fs.mkdirSync(path.join(copy, 'fonts'), { recursive: true });
      fs.copyFileSync(fonts![1].path, path.join(copy, 'fonts', 'brand.ttf'));
    });
    project.write('label.part.js', [
      `import { part, sketch, text, extrude } from 'fluidcad/core';`,
      ``,
      `export const label = part('Label', () => {`,
      `  sketch('xy', () => {`,
      `    text('A').size(10).font('packages/${KIT}/${VERSION}/fonts/brand.ttf');`,
      `  });`,
      `  extrude(1);`,
      `});`,
      ``,
    ].join('\n'));
    const data = await quietly(() => server.processFile(project.at('label.part.js')));
    expect(errorsOf(data)).toEqual([]);

    await expect(collectEntryFiles(project.at('label.part.js'), project.root, { assets: server.getRenderAssets() }))
      .rejects.toThrow(
        `Links can't carry packages yet (\`${KIT}\`): the model reads packages/${KIT}/${VERSION}/fonts/brand.ttf, which belongs to it.`,
      );
  });
});

describe('PackageAssetRoots.rootOf', () => {
  it('answers a project copy\'s directory keyed by its path in the project, a library copy\'s with no key', async () => {
    const copy = await project.install(KIT, VERSION, { target: 'project' });
    const library = await project.install(KIT, '0.2.0', { target: 'library' });

    expect(PackageAssetRoots.rootOf(`${copy.dir}/parts/spacer.part.js`, project.root)).toEqual({
      dir: copy.dir, key: `packages/${KIT}/${VERSION}/`, label: `${KIT}@${VERSION}`,
    });
    expect(PackageAssetRoots.rootOf(`${library.dir}/parts/spacer.part.js`, project.root)).toEqual({
      dir: library.dir, key: null, label: `${KIT}@0.2.0`,
    });
  });

  it('answers null for the project\'s own files, a fork with a manifest elsewhere in it included', () => {
    project.write('vendor/gears/manifest.json', '{}');
    project.write('vendor/gears/parts/spur.part.js', '');

    expect(PackageAssetRoots.rootOf(project.at('own.part.js'), project.root)).toBeNull();
    expect(PackageAssetRoots.rootOf(project.at('vendor/gears/parts/spur.part.js'), project.root)).toBeNull();
  });
});
