import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { FluidCadServer } from '../src/fluidcad-server/index.ts';
import { LocalSceneHost } from '../src/host/local-scene-host.ts';
import type { SceneRenderedData } from '../src/fluidcad-server/render-types.ts';

// A generator's code changed in a plain workspace module — a helper its
// class imports, no `*.feature.js` in sight — with the insert's values
// untouched: the save's re-render rebuilds the generated part, and neither
// the previous render's compare nor the generated-part cache (which outlives
// one render) serves the old code's shape again. The template's identity is
// its type and inputs, which a code-only edit changes neither of; the
// module graph's importers carry the save to the module that defines the
// generated assembly, and the engine gives that definition a new code
// version. Over a real workspace, as the watcher drives it (index.ts): note
// the file, then re-render when the render is behind.

/** The crate's depth, from a helper module. */
const sizeSource = (depth: number) => `export const DEPTH = ${depth};\n`;

/** A generator whose one part — a box `width` × DEPTH × 5 — reads DEPTH from the helper. */
const CRATE_SOURCE = [
  `import { Generator } from 'fluidcad/sdk';`,
  `import { ShapeFactory } from 'fluidcad/sdk/kernel';`,
  `import { DEPTH } from './size.js';`,
  ``,
  `export class Crate extends Generator.with({ width: { type: 'length', default: 20, min: 1 } }) {`,
  `  static id = 'acme.crate';`,
  ``,
  `  layout(g) {`,
  `    const box = g.part('box', { name: 'Box', inputs: { width: this.values.width } });`,
  `    return { box };`,
  `  }`,
  ``,
  `  static build(type, inputs, ctx) {`,
  `    return [ctx.occ(({ oc, track }) => ShapeFactory.fromShape(track(new oc.BRepPrimAPI_MakeBox(inputs.width, DEPTH, 5).Shape())))];`,
  `  }`,
  `}`,
  ``,
].join('\n');

const CRATE_ASSEMBLY = [
  `import { defineAssembly } from 'fluidcad/sdk';`,
  `import { Crate } from '../features/lib/crate.js';`,
  ``,
  `export const crate = defineAssembly(Crate, { label: 'Crate' });`,
  ``,
].join('\n');

/**
 * The model: the crate inserted `width` wide. `trailer` is appended — an
 * edit of the model's own text that changes no statement, so the server
 * renders again rather than serve its cached render.
 */
function shopSource(width: number, trailer = ''): string {
  return [
    `import { assembly, insert } from 'fluidcad/core';`,
    `import { crate } from './assemblies/crate.assembly.js';`,
    ``,
    `export const shop = assembly('shop', () => {`,
    `  insert(crate, { width: ${width} }).name('crate1');`,
    `});`,
    trailer,
  ].join('\n');
}

/** The disc's height, from a helper module the feature imports. */
const heightSource = (height: number) => `export const HEIGHT = ${height};\n`;

/** A feature — a disc `radius` round, HEIGHT tall — in a feature module that reads HEIGHT from a helper. */
const DISC_FEATURE = [
  `import { Feature, defineFeature } from 'fluidcad/sdk';`,
  `import { Primitives } from 'fluidcad/sdk/kernel';`,
  `import { Plane } from 'fluidcad/math';`,
  `import { HEIGHT } from './lib/height.js';`,
  ``,
  `export class Disc extends Feature.with({ radius: { type: 'length', default: 10, min: 1 } }, { frames: { axis: {} } }) {`,
  `  static id = 'acme.disc';`,
  ``,
  `  buildTool() {`,
  `    this.setFrames({ axis: Plane.XY() });`,
  `    return [Primitives.makeCylinder(this.values.radius, HEIGHT)];`,
  `  }`,
  `}`,
  ``,
  `export const disc = defineFeature(Disc, { label: 'Disc', group: 'create', operations: ['new', 'add'], call: [{ radius: 'radius' }] });`,
  ``,
].join('\n');

/** The disc as a generated part (definePart). */
const DISC_PART = [
  `import { definePart } from 'fluidcad/sdk';`,
  `import { Disc } from '../features/disc.feature.js';`,
  ``,
  `export const discPart = definePart(Disc, { label: 'Disc' });`,
  ``,
].join('\n');

/** The second model: the disc part inserted `radius` round. */
function gearsSource(radius: number, trailer = ''): string {
  return [
    `import { assembly, insert } from 'fluidcad/core';`,
    `import { discPart } from './parts/disc.part.js';`,
    ``,
    `export const gears = assembly('gears', () => {`,
    `  insert(discPart, { radius: ${radius} }).name('disc1');`,
    `});`,
    trailer,
  ].join('\n');
}

let root: string;
let host: LocalSceneHost;
let server: FluidCadServer;

const at = (rel: string) => path.join(root, rel).replace(/\\/g, '/');

/** Write a file and move its mtime forward, so a same-tick rewrite still reads as a change. */
function write(rel: string, content: string): void {
  fs.mkdirSync(path.dirname(at(rel)), { recursive: true });
  fs.writeFileSync(at(rel), content);
  const later = new Date(Date.now() + 2000 + Math.random() * 1000);
  fs.utimesSync(at(rel), later, later);
}

/** Render the model as its editor's live update does. */
function render(width = 20, trailer = ''): Promise<SceneRenderedData | null> {
  return server.updateLiveCode(at('shop.assembly.js'), shopSource(width, trailer));
}

/** Save a workspace file as the watcher sees it: the server hears of it, then the model renders again when it is behind. */
async function save(rel: string, content: string, width = 20): Promise<{ noted: boolean; rendered: SceneRenderedData | null }> {
  write(rel, content);
  const noted = server.noteFileChange(at(rel));
  return { noted, rendered: server.isRenderBehind(at(rel)) ? await render(width) : null };
}

type Row = { type: string; fromCache?: boolean; hasError?: boolean; errorMessage?: string; sceneShapes?: { shapeId: string }[] };

function errorsOf(data: SceneRenderedData | null): string[] {
  return (data!.result as Row[]).flatMap(row => row.hasError ? [`${row.type}: ${row.errorMessage}`] : []);
}

/** The volume of every solid the render shows: the crate's one template. */
function volumeOf(data: SceneRenderedData | null): number {
  return (data!.result as Row[])
    .flatMap(row => row.sceneShapes ?? [])
    .reduce((sum, shape) => sum + (server.getShapeProperties(shape.shapeId)?.volumeMm3 ?? 0), 0);
}

/** Whether the crate's part took a build it did not make this render (the previous render's, or the cache's). */
function boxFromCache(data: SceneRenderedData | null): boolean | undefined {
  return (data!.result as Row[]).find(row => row.type === 'part')?.fromCache;
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fluidcad-generated-code-'));
  fs.writeFileSync(at('init.js'), `import { init } from 'fluidcad'\n\nexport default await init()\n`);
  write('features/lib/size.js', sizeSource(10));
  write('features/lib/crate.js', CRATE_SOURCE);
  write('assemblies/crate.assembly.js', CRATE_ASSEMBLY);
  write('notes.js', `export const unrelated = 1;\n`);
  write('shop.assembly.js', shopSource(20));
  write('features/lib/height.js', heightSource(5));
  write('features/disc.feature.js', DISC_FEATURE);
  write('parts/disc.part.js', DISC_PART);
  write('gears.assembly.js', gearsSource(10));
  host = new LocalSceneHost();
  server = new FluidCadServer(host);
  await server.init(root);
});

afterEach(async () => {
  await host?.server.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('a generator\'s helper module saved with new code', () => {
  it('rebuilds the generated part on the save\'s re-render, though its type and inputs are unchanged', async () => {
    const first = await render();
    expect(errorsOf(first)).toEqual([]);
    expect(volumeOf(first)).toBeCloseTo(20 * 10 * 5, 3);

    // The same inputs again: the previous render's part, carried over.
    const same = await render(20, '// again');
    expect(boxFromCache(same)).toBe(true);

    const { noted, rendered } = await save('features/lib/size.js', sizeSource(12));
    expect(noted).toBe(true);
    expect(rendered).not.toBeNull();
    expect(errorsOf(rendered)).toEqual([]);
    expect(boxFromCache(rendered)).toBe(false);
    expect(volumeOf(rendered)).toBeCloseTo(20 * 12 * 5, 3);

    // Rendered again with the saved code, it caches as before.
    const after = await render(20, '// after');
    expect(boxFromCache(after)).toBe(true);
    expect(volumeOf(after)).toBeCloseTo(20 * 12 * 5, 3);
  });

  it('never serves the generated-part cache\'s old shapes: a part the cache held from before the save is built again', async () => {
    await render(20);
    // The 30-wide crate leaves the 20-wide part in the cache; going back takes it.
    expect(volumeOf(await render(30))).toBeCloseTo(30 * 10 * 5, 3);
    const back = await render(20);
    expect(boxFromCache(back)).toBe(true);
    expect(volumeOf(back)).toBeCloseTo(20 * 10 * 5, 3);

    // The cache holds the 30-wide part, built with DEPTH 10.
    const { rendered } = await save('features/lib/size.js', sizeSource(14));
    expect(volumeOf(rendered)).toBeCloseTo(20 * 14 * 5, 3);
    const wide = await render(30);
    expect(errorsOf(wide)).toEqual([]);
    expect(boxFromCache(wide)).toBe(false);
    expect(volumeOf(wide)).toBeCloseTo(30 * 14 * 5, 3);
  });

  it('rebuilds when the module that defines the generated assembly is saved, and ignores a module nothing imports', async () => {
    await render();
    const unrelated = await save('notes.js', `export const unrelated = 2;\n`);
    expect(unrelated.noted).toBe(false);
    expect(unrelated.rendered).toBeNull();

    const relabelled = await save('assemblies/crate.assembly.js', CRATE_ASSEMBLY.replace(`label: 'Crate'`, `label: 'Box crate'`));
    expect(relabelled.noted).toBe(true);
    expect(relabelled.rendered).not.toBeNull();
    expect(errorsOf(relabelled.rendered)).toEqual([]);
    expect(boxFromCache(relabelled.rendered)).toBe(false);
    expect(volumeOf(relabelled.rendered)).toBeCloseTo(20 * 10 * 5, 3);
  });
});

/** Render the disc model as its editor's live update does. */
function renderGears(radius = 10, trailer = ''): Promise<SceneRenderedData | null> {
  return server.updateLiveCode(at('gears.assembly.js'), gearsSource(radius, trailer));
}

/** Save a workspace file as the watcher sees it, then re-render the disc model when it is behind. */
async function saveForGears(rel: string, content: string, radius = 10): Promise<{ noted: boolean; rendered: SceneRenderedData | null }> {
  write(rel, content);
  const noted = server.noteFileChange(at(rel));
  return { noted, rendered: server.isRenderBehind(at(rel)) ? await renderGears(radius) : null };
}

const discVolume = (radius: number, height: number) => Math.PI * radius * radius * height;

// A generated part's variants (definePart, F2) are kept by the same cache:
// a save of the feature's module — here a helper it imports — gives the
// definition a new code version, so neither the compare nor the cache serves
// the old code's disc, whichever variant comes back.
describe('a generated part\'s feature helper saved with new code', () => {
  it('rebuilds the variant on the save\'s re-render, though its values are unchanged', async () => {
    const first = await renderGears(10);
    expect(errorsOf(first)).toEqual([]);
    expect(volumeOf(first)).toBeCloseTo(discVolume(10, 5), 1);
    expect(boxFromCache(await renderGears(10, '// again'))).toBe(true);

    const { noted, rendered } = await saveForGears('features/lib/height.js', heightSource(7));
    expect(noted).toBe(true);
    expect(rendered).not.toBeNull();
    expect(errorsOf(rendered)).toEqual([]);
    expect(boxFromCache(rendered)).toBe(false);
    expect(volumeOf(rendered)).toBeCloseTo(discVolume(10, 7), 1);
    expect(boxFromCache(await renderGears(10, '// after'))).toBe(true);
  });

  it('revisits a variant from the cache, and never serves the cache\'s old variant after a save', async () => {
    await renderGears(10);
    expect(volumeOf(await renderGears(20))).toBeCloseTo(discVolume(20, 5), 1);
    // Back to 10: the cache's, built.
    const back = await renderGears(10);
    expect(boxFromCache(back)).toBe(true);
    expect(volumeOf(back)).toBeCloseTo(discVolume(10, 5), 1);
    const report = (server as any).sceneManager.getGeneratedReport((server as any).previousScenes.get(at('gears.assembly.js')));
    expect(report.variants.map((v: any) => [v.values.radius, v.source])).toEqual([[10, 'cached']]);

    // The cache holds the 20-round disc, 5 tall; the save makes it the old code's.
    const { rendered } = await saveForGears('features/lib/height.js', heightSource(9));
    expect(volumeOf(rendered)).toBeCloseTo(discVolume(10, 9), 1);
    const wide = await renderGears(20);
    expect(errorsOf(wide)).toEqual([]);
    expect(boxFromCache(wide)).toBe(false);
    expect(volumeOf(wide)).toBeCloseTo(discVolume(20, 9), 1);
  });
});
