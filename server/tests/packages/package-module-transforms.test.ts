import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { FluidCadServer } from '../../src/fluidcad-server/index.ts';
import { LocalSceneHost } from '../../src/host/local-scene-host.ts';
import { PackageModuleTransforms } from '../../src/host/package-module-transforms.ts';
import { TreeHash } from '../../src/packages/tree-hash.ts';
import type { PackageRoot } from '../../src/packages/resolver.ts';
import type { SceneRenderedData } from '../../src/fluidcad-server/render-types.ts';
import { PackageProject } from './package-project.ts';

// F1: an installed package's modules keep Vite's transform from one render
// to the next while their package tree and their own file are unchanged —
// and are evaluated again on every render all the same (K9), so whatever
// their evaluation registers for a scene happens for every render exactly as
// before. A workspace's own modules are transformed and evaluated again on
// every render.

describe('PackageModuleTransforms', () => {
  const KIT = '/lib/@acme/kit/0.1.0';
  const root = (directory = KIT): PackageRoot => ({
    target: 'library', root: '/lib', name: '@acme/kit', version: directory.split('/').pop()!, directory,
  });

  /** A rule over fake package roots, trees and files; `state` is what the fakes read. */
  function rule() {
    const state = {
      trees: new Map<string, string>([[KIT, 'sha256-a'], ['/lib/@acme/kit/0.2.0', 'sha256-b']]),
      files: new Map<string, string>(),
      overridden: new Set<string>(),
      treeReads: 0,
    };
    const transforms = new PackageModuleTransforms({
      rootOf: (file) => {
        const match = /^(\/lib\/@acme\/kit\/[^/]+)\//.exec(file);
        return match ? root(match[1]) : null;
      },
      overridden: (file) => state.overridden.has(file),
      treeOf: (directory) => {
        state.treeReads++;
        const tree = state.trees.get(directory);
        if (tree === undefined) {
          throw new Error('no such tree');
        }
        return tree;
      },
      fileOf: (file) => state.files.get(file) ?? 'disk',
    });
    return { transforms, state };
  }

  it('keeps an installed package\'s module transformed from disk while its tree and its file are the same, reading each tree once a render', () => {
    const { transforms, state } = rule();
    transforms.startPass();
    transforms.noteTransformed(`${KIT}/index.js`);
    transforms.noteTransformed(`${KIT}/parts/spacer.part.js`);
    expect(state.treeReads).toBe(1);

    for (let pass = 0; pass < 3; pass++) {
      transforms.startPass();
      expect(transforms.keeps(`${KIT}/index.js`)).toBe(true);
      expect(transforms.keeps(`${KIT}/parts/spacer.part.js`)).toBe(true);
    }
    expect(state.treeReads).toBe(4);
    expect(transforms.size()).toBe(2);
    expect(transforms.isPackageModule(`${KIT}/index.js?raw`)).toBe(true);
    expect(transforms.isPackageModule('/ws/model.part.js')).toBe(false);
  });

  it('never keeps a workspace module, nor a package module it saw no transform of', () => {
    const { transforms } = rule();
    transforms.startPass();
    transforms.noteTransformed('/ws/model.part.js');
    expect(transforms.keeps('/ws/model.part.js')).toBe(false);
    expect(transforms.keeps('virtual:live-render:/ws/model.part.js')).toBe(false);
    expect(transforms.keeps(`${KIT}/index.js`)).toBe(false);
    expect(transforms.size()).toBe(0);
  });

  it('drops the transform once the package\'s tree moves — a tree replaced in place, a file edited under it — and keeps the new one', () => {
    const { transforms, state } = rule();
    transforms.startPass();
    transforms.noteTransformed(`${KIT}/index.js`);
    state.trees.set(KIT, 'sha256-replaced');
    transforms.startPass();
    expect(transforms.keeps(`${KIT}/index.js`)).toBe(false);
    // The miss forgot it: the next render keeps nothing until it is transformed again.
    expect(transforms.size()).toBe(0);
    transforms.noteTransformed(`${KIT}/index.js`);
    transforms.startPass();
    expect(transforms.keeps(`${KIT}/index.js`)).toBe(true);
  });

  it('drops the transform when the module\'s own file was written, even with the tree\'s stamp unmoved', () => {
    const { transforms, state } = rule();
    transforms.startPass();
    transforms.noteTransformed(`${KIT}/helpers/sizes.js`);
    state.files.set(`${KIT}/helpers/sizes.js`, 'written again');
    transforms.startPass();
    expect(transforms.keeps(`${KIT}/helpers/sizes.js`)).toBe(false);
  });

  it('drops the transform of a package directory that is gone, or can no longer be read', () => {
    const { transforms, state } = rule();
    transforms.startPass();
    transforms.noteTransformed(`${KIT}/index.js`);
    state.trees.delete(KIT);
    transforms.startPass();
    expect(transforms.keeps(`${KIT}/index.js`)).toBe(false);
  });

  it('never keeps text that came from a live buffer or an overlay, when it was transformed or now', () => {
    const { transforms, state } = rule();
    state.overridden.add(`${KIT}/helpers/sizes.js`);
    transforms.startPass();
    transforms.noteTransformed(`${KIT}/helpers/sizes.js`);
    expect(transforms.keeps(`${KIT}/helpers/sizes.js`)).toBe(false);

    transforms.noteTransformed(`${KIT}/index.js`);
    state.overridden.add(`${KIT}/index.js`);
    transforms.startPass();
    expect(transforms.keeps(`${KIT}/index.js`)).toBe(false);
  });

  it('keeps each version\'s transforms apart: they are other directories, other module ids', () => {
    const { transforms } = rule();
    transforms.startPass();
    transforms.noteTransformed(`${KIT}/index.js`);
    transforms.noteTransformed('/lib/@acme/kit/0.2.0/index.js');
    transforms.startPass();
    expect(transforms.keeps(`${KIT}/index.js`)).toBe(true);
    expect(transforms.keeps('/lib/@acme/kit/0.2.0/index.js')).toBe(true);
  });
});

/** A rectangle of four pinned lines, as a fully constrained sketch body. */
function rectangle(x: number, y: number, w: number, h: number): string {
  const [a, b, c, d] = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]].map(p => `[${p[0]}, ${p[1]}]`);
  return [
    `  const a = line(${a}, ${b}); const b = line(${b}, ${c}); const c = line(${c}, ${d}); const d = line(${d}, ${a});`,
    `  coincident(a.end(), b.start()); coincident(b.end(), c.start()); coincident(c.end(), d.start()); coincident(d.end(), a.start());`,
    `  fix(a.start(), ${a}); fix(b.start(), ${b}); fix(c.start(), ${c}); fix(d.start(), ${d});`,
  ].join('\n');
}

/** A `width` × 30 × 5 plate with the kit's standoff 12 tall on top; `probe.js` is a workspace module the model imports. */
function model(width = 40, extra = ''): string {
  return [
    `import { standoff } from '@acme/kit';`,
    `import { PROBE } from './probe.js';`,
    `import { sketch, extrude, line, select } from 'fluidcad/core';`,
    `import { coincident, fix } from 'fluidcad/constraints';`,
    `import { face } from 'fluidcad/filters';`,
    ``,
    `sketch('xy', () => {`,
    rectangle(0, 0, width, 30),
    `});`,
    `extrude(5);`,
    `const top = select(face().planar().onPlane('xy', 5));`,
    `standoff(top, { height: 12 });`,
    extra,
    ``,
  ].join('\n');
}

/** The kit's spacer inserted in an assembly. */
const ASSEMBLY = [
  `import { insert } from 'fluidcad/core';`,
  `import { spacer } from '@acme/kit';`,
  ``,
  `insert(spacer);`,
  ``,
].join('\n');

const tube = (height: number) => Math.PI * (3 ** 2 - 1.5 ** 2) * height;
/** The spacer, `length` inches long and 0.25 in round — in mm³. */
const spacerVolume = (length = 0.5) => Math.PI * 0.25 ** 2 * length * 25.4 ** 3;

/** How many times a kit module evaluated in this process: `helpers/sizes.js` counts itself (see {@link countingEvaluations}). */
const EVALUATIONS = '__acmeKitEvaluations';

/** A kit edit: `helpers/sizes.js` counts its own evaluations on a global, so a test sees each one. */
function countingEvaluations(dir: string): void {
  const file = path.join(dir, 'helpers/sizes.js');
  fs.appendFileSync(file, `\nglobalThis.${EVALUATIONS} = (globalThis.${EVALUATIONS} ?? 0) + 1;\n`);
}

type Row = {
  type: string;
  hasError?: boolean;
  errorMessage?: string;
  sceneShapes?: { shapeId: string }[];
  sourceLocation?: { filePath: string; line: number; column?: number };
};

let project: PackageProject;
let host: LocalSceneHost | null;
let server: FluidCadServer;
/** Every module id Vite's plugin pipeline transformed (cache hits never reach it), in order. */
let transformed: string[];

async function boot(): Promise<void> {
  host = new LocalSceneHost();
  server = new FluidCadServer(host);
  await quietly(() => server.init(project.root));
  const container = host.server.environments.ssr.pluginContainer;
  const transform = container.transform.bind(container);
  container.transform = (async (code: string, id: string, ...rest: any[]) => {
    transformed.push(id);
    return (transform as any)(code, id, ...rest);
  }) as typeof container.transform;
}

/** Install a kit version into the library (after `edit`) and pin it; answers its directory. */
async function pinKit(version = '0.1.0', edit?: (dir: string) => void): Promise<string> {
  const { dir, integrity } = await project.install('@acme/kit', version, { edit });
  project.config({ '@acme/kit': { version, integrity } });
  return dir;
}

/** What `fn`'s renders transformed: the ids under `dir`, as paths relative to it. */
async function transformsDuring<T>(dir: string, fn: () => Promise<T>): Promise<{ result: T; inside: string[]; all: string[] }> {
  const from = transformed.length;
  const result = await fn();
  const all = transformed.slice(from);
  const inside = all.filter(id => id.startsWith(`${dir}/`)).map(id => id.slice(dir.length + 1)).sort();
  return { result, inside, all };
}

function render(code = model()): Promise<SceneRenderedData | null> {
  return quietly(() => server.updateLiveCode(project.at('model.part.js'), code));
}

function rowsOf(data: SceneRenderedData | null): Row[] {
  return data!.result as Row[];
}

function errorsOf(data: SceneRenderedData | null): string[] {
  return rowsOf(data).flatMap(row => row.hasError ? [`${row.type}: ${row.errorMessage}`] : []);
}

function volumeOf(rows: Row[]): number {
  return rows
    .flatMap(row => row.sceneShapes ?? [])
    .reduce((sum, shape) => sum + (server.getShapeProperties(shape.shapeId)?.volumeMm3 ?? 0), 0);
}

async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    return await fn();
  } finally {
    log.mockRestore();
  }
}

beforeEach(() => {
  project = new PackageProject('fluidcad-package-transforms-');
  project.write('probe.js', `export const PROBE = 1;\n`);
  project.write('model.part.js', model());
  project.write('model.assembly.js', ASSEMBLY);
  host = null;
  transformed = [];
  delete (globalThis as any)[EVALUATIONS];
});

afterEach(async () => {
  await host?.server.close();
  project.dispose();
  delete (globalThis as any)[EVALUATIONS];
});

describe('an installed package\'s modules across renders', () => {
  it('are transformed once and evaluated again on every render, while the workspace\'s own modules are transformed again too', async () => {
    const kit = await pinKit('0.1.0', countingEvaluations);
    await boot();

    const first = await transformsDuring(kit, () => render());
    expect(errorsOf(first.result)).toEqual([]);
    expect(volumeOf(rowsOf(first.result))).toBeCloseTo(40 * 30 * 5 + tube(12), 3);
    expect(first.inside).toEqual(['helpers/sizes.js', 'index.js', 'parts/spacer.part.js', 'standoff.feature.js']);
    expect((globalThis as any)[EVALUATIONS]).toBe(1);
    const firstSpacer = (await host!.loadModuleRaw(`${kit}/parts/spacer.part.js`)).spacer;

    for (let n = 2; n <= 4; n++) {
      const next = await transformsDuring(kit, () => render(model(40 + n)));
      expect(errorsOf(next.result)).toEqual([]);
      expect(volumeOf(rowsOf(next.result))).toBeCloseTo((40 + n) * 30 * 5 + tube(12), 3);
      // Nothing of the package transformed again…
      expect(next.inside).toEqual([]);
      // …every module of it evaluated again…
      expect((globalThis as any)[EVALUATIONS]).toBe(n);
      // …and the workspace's own modules transformed again: the live buffer and what it imports.
      expect(next.all).toContain(`virtual:live-render:${project.at('model.part.js')}`);
      expect(next.all).toContain(project.at('probe.js'));
    }
    // A fresh definition each render, as a fresh evaluation makes it.
    const lastSpacer = (await host!.loadModuleRaw(`${kit}/parts/spacer.part.js`)).spacer;
    expect(lastSpacer).toBeDefined();
    expect(lastSpacer).not.toBe(firstSpacer);
  });

  it('attribute a package part\'s rows to the same package lines from a kept transform as from a fresh one', async () => {
    const kit = await pinKit();
    await boot();
    const locations = (data: SceneRenderedData | null) => rowsOf(data)
      .filter(row => row.sourceLocation?.filePath === `${kit}/parts/spacer.part.js`)
      .map(row => [row.type, row.sourceLocation!.line, row.sourceLocation!.column]);

    const first = await transformsDuring(kit, () => quietly(() => server.processFile(project.at('model.assembly.js'))));
    expect(first.inside).toContain('parts/spacer.part.js');
    const again = await transformsDuring(kit, () => quietly(() => server.processFile(project.at('model.assembly.js'), true)));
    expect(again.inside).toEqual([]);
    expect(errorsOf(again.result)).toEqual([]);
    expect(locations(again.result).length).toBeGreaterThan(1);
    expect(locations(again.result)).toEqual(locations(first.result));
    expect(volumeOf(rowsOf(again.result))).toBeCloseTo(spacerVolume(), 3);
  });

  it('are transformed again once their tree is replaced in place under the same version, and the new code builds', async () => {
    const kit = await pinKit();
    await boot();
    const first = await quietly(() => server.processFile(project.at('model.assembly.js')));
    expect(volumeOf(rowsOf(first))).toBeCloseTo(spacerVolume(), 3);

    // A replace of 0.1.0 (`--replace`): other contents, re-pinned.
    PackageProject.chmodFiles(kit, 0o644);
    const sizes = `${kit}/helpers/sizes.js`;
    fs.writeFileSync(sizes, fs.readFileSync(sizes, 'utf8').replace('SPACER_LENGTH = 0.5', 'SPACER_LENGTH = 0.75'));
    const integrity = await TreeHash.ofDirectory(kit);
    PackageProject.chmodFiles(kit, 0o444);
    project.config({ '@acme/kit': { version: '0.1.0', integrity } });

    const replaced = await transformsDuring(kit, () => quietly(() => server.processFile(project.at('model.assembly.js'), true)));
    expect(errorsOf(replaced.result)).toEqual([]);
    expect(replaced.inside).toEqual(expect.arrayContaining(['helpers/sizes.js', 'index.js', 'parts/spacer.part.js']));
    expect(volumeOf(rowsOf(replaced.result))).toBeCloseTo(spacerVolume(0.75), 3);

    // Settled again: kept from there.
    const settled = await transformsDuring(kit, () => quietly(() => server.processFile(project.at('model.assembly.js'), true)));
    expect(settled.inside).toEqual([]);
    expect(volumeOf(rowsOf(settled.result))).toBeCloseTo(spacerVolume(0.75), 3);
  });

  it('switch to another pinned version and back: each version transformed once, the one pinned is the one evaluated', async () => {
    const v1 = await pinKit('0.1.0');
    await boot();
    expect(volumeOf(rowsOf(await render()))).toBeCloseTo(40 * 30 * 5 + tube(12), 3);

    const v2 = await pinKit('0.2.0');
    const upgraded = await transformsDuring(v2, () => render(model(40, '// 0.2.0')));
    expect(errorsOf(upgraded.result)).toEqual([]);
    expect(upgraded.inside).toEqual(['helpers/sizes.js', 'index.js', 'parts/spacer.part.js', 'standoff.feature.js']);
    // 0.2.0's standoff stands 5 taller than asked.
    expect(volumeOf(rowsOf(upgraded.result))).toBeCloseTo(40 * 30 * 5 + tube(17), 3);

    // Pinned back: 0.1.0's transforms were kept, its code evaluated again.
    project.config({ '@acme/kit': { version: '0.1.0', integrity: TreeHash.ofDirectorySync(v1) } });
    const back = await transformsDuring(v1, () => render(model(40, '// back')));
    expect(errorsOf(back.result)).toEqual([]);
    expect(back.inside).toEqual([]);
    expect(volumeOf(rowsOf(back.result))).toBeCloseTo(40 * 30 * 5 + tube(12), 3);
    expect(host!.resolvedPackages()).toMatchObject([{ name: '@acme/kit', version: '0.1.0' }]);
  });

  it('are transformed again from a live buffer the host holds for a package file, exactly as before', async () => {
    const kit = await pinKit();
    await boot();
    expect(volumeOf(rowsOf(await quietly(() => server.processFile(project.at('model.assembly.js')))))).toBeCloseTo(spacerVolume(), 3);

    const sizes = `${kit}/helpers/sizes.js`;
    host!.setBuffer(`virtual:live-render:${sizes}`, fs.readFileSync(sizes, 'utf8').replace('SPACER_LENGTH = 0.5', 'SPACER_LENGTH = 1'));
    const buffered = await transformsDuring(kit, () => quietly(() => server.processFile(project.at('model.assembly.js'), true)));
    expect(buffered.inside).toContain('helpers/sizes.js');
    expect(volumeOf(rowsOf(buffered.result))).toBeCloseTo(spacerVolume(1), 3);
    // Never kept while the buffer stands.
    const again = await transformsDuring(kit, () => quietly(() => server.processFile(project.at('model.assembly.js'), true)));
    expect(again.inside).toEqual(['helpers/sizes.js']);
    expect(volumeOf(rowsOf(again.result))).toBeCloseTo(spacerVolume(1), 3);
  });

  it('make a module-level kernel solid afresh every render, so a feature built from copies of it never reads freed memory (SL)', async () => {
    // A feature whose every build returns a copy of a solid its module made
    // when it evaluated — a wrapper over the same raw handle (`Solid.copy`),
    // freed with the scene that holds the feature. Sound only because the
    // module evaluates again for every render.
    const kit = await pinKit('0.1.0', (dir) => {
      fs.writeFileSync(path.join(dir, 'post.feature.js'), [
        `import { Feature, defineFeature } from 'fluidcad/sdk';`,
        `import { Primitives } from 'fluidcad/sdk/kernel';`,
        ``,
        `const POST = Primitives.makeCylinder(2, 7);`,
        `globalThis.__acmePosts = [...(globalThis.__acmePosts ?? []), POST];`,
        ``,
        `export class Post extends Feature.with({`,
        `  height: { type: 'length', default: 7, min: 0, description: 'Shown only: the post is the module\\'s own solid.' },`,
        `}) {`,
        `  static id = 'acme.post';`,
        ``,
        `  buildTool() {`,
        `    return [POST.copy()];`,
        `  }`,
        `}`,
        ``,
        `export const post = defineFeature(Post, {`,
        `  label: 'Post',`,
        `  description: 'A post copied from a solid its module made',`,
        `  group: 'create',`,
        `  operations: ['new'],`,
        `  call: [{ height: 'height' }],`,
        `});`,
        ``,
      ].join('\n'));
      fs.appendFileSync(path.join(dir, 'index.js'), `export { post } from './post.feature.js';\n`);
    });
    await boot();
    const posted = (width: number) => model(width, 'post({ height: 7 });').replace(
      `import { standoff } from '@acme/kit';`, `import { standoff, post } from '@acme/kit';`);
    const post = Math.PI * 2 ** 2 * 7;
    try {
      // Every width rebuilds the plate and what follows it, so each compare
      // frees the previous post — and with it the raw handle of the solid
      // the previous evaluation made.
      for (const [n, width] of [40, 44, 40, 48].entries()) {
        const step = await transformsDuring(kit, () => render(posted(width)));
        expect(errorsOf(step.result)).toEqual([]);
        expect(volumeOf(rowsOf(step.result))).toBeCloseTo(width * 30 * 5 + tube(12) + post, 3);
        expect(step.inside).toEqual(n === 0 ? expect.arrayContaining(['post.feature.js']) : []);
        expect((globalThis as any).__acmePosts).toHaveLength(n + 1);
      }
      const posts = (globalThis as any).__acmePosts as unknown[];
      expect(new Set(posts).size).toBe(posts.length);
    } finally {
      delete (globalThis as any).__acmePosts;
    }
  });
});
