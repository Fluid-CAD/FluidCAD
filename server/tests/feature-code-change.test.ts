import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { FluidCadServer } from '../src/fluidcad-server/index.ts';
import { LocalSceneHost } from '../src/host/local-scene-host.ts';
import type { SceneRenderedData } from '../src/fluidcad-server/render-types.ts';

// A feature module saved with new code — its statements' values untouched —
// rebuilds those statements on the re-render the save triggers, and the next
// ghost draws the new code. The render cache matches a statement by its type
// and its values, so without the save's word the old geometry would stay
// until a value changed or the engine restarted. Over a real workspace: the
// Vite host renders the model with this repo's kernel, the way every editor
// host's engine does, and the save is what the workspace watcher does with
// it (index.ts): note the file, then re-render when the render is behind.

const FIXTURES = path.resolve(__dirname, 'fixtures/custom-features');
const STANDOFF_SOURCE = fs.readFileSync(path.join(FIXTURES, 'standoff.feature.js'), 'utf8');

/** The standoff with a code-only edit: 5 taller than its height says. */
const STANDOFF_TALLER = STANDOFF_SOURCE.replace(
  'const { height, outer, hole } = this.values;',
  'const { outer, hole } = this.values;\n    const height = this.values.height + 5;',
);

/** Another workspace feature: a ring beside the plate, its wall from a helper module. */
const COLLAR_SOURCE = [
  `import { Feature, defineFeature } from 'fluidcad/sdk';`,
  `import { BooleanOps, Primitives, ShapeOps } from 'fluidcad/sdk/kernel';`,
  `import { Matrix4 } from 'fluidcad/math';`,
  `import { WALL } from './collar-size.js';`,
  ``,
  `export class Collar extends Feature.with({ height: { type: 'length', default: 3, min: 0 } }) {`,
  `  static id = 'acme.collar';`,
  ``,
  `  buildTool() {`,
  `    const outer = Primitives.makeCylinder(4, this.values.height);`,
  `    const inner = Primitives.makeCylinder(4 - WALL, this.values.height);`,
  `    const ring = BooleanOps.cutShapes(outer, inner);`,
  `    outer.dispose();`,
  `    inner.dispose();`,
  `    const placed = ShapeOps.transform(ring, Matrix4.fromTranslation(-20, 15, 0));`,
  `    ring.dispose();`,
  `    return [placed];`,
  `  }`,
  `}`,
  ``,
  `export const collar = defineFeature(Collar, { label: 'Collar', group: 'create', operations: ['new'], call: [{ height: 'height' }] });`,
  ``,
].join('\n');

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
 * The model: a 40 × 30 × 5 plate (built-ins), a collar beside it (another
 * custom feature), a standoff 12 tall on the plate's top, then a block of
 * its own (a built-in after the standoff). `trailer` is appended — an edit
 * of the model's own text that changes no statement.
 */
function modelSource(trailer = ''): string {
  return [
    `import { sketch, extrude, line, select } from 'fluidcad/core';`,
    `import { coincident, fix } from 'fluidcad/constraints';`,
    `import { face } from 'fluidcad/filters';`,
    `import { standoff } from './standoff.feature.js';`,
    `import { collar } from './collar.feature.js';`,
    ``,
    `sketch('xy', () => {`,
    rectangle(0, 0, 40, 30),
    `});`,
    `const plate = extrude(5);`,
    `collar({ height: 3 });`,
    `const top = select(face().planar().onPlane('xy', 5));`,
    `standoff(top, { height: 12 });`,
    `sketch('xy', () => {`,
    rectangle(60, 0, 4, 4),
    `});`,
    `extrude(2);`,
    trailer,
  ].join('\n');
}

const PLATE = 40 * 30 * 5;
const BLOCK = 4 * 4 * 2;
const tube = (height: number) => Math.PI * (3 ** 2 - 1.5 ** 2) * height;
const ring = (wall: number) => Math.PI * (4 ** 2 - (4 - wall) ** 2) * 3;

let root: string;
let host: LocalSceneHost;
let server: FluidCadServer;

const at = (rel: string) => path.join(root, rel).replace(/\\/g, '/');

/** Write a file and move its mtime forward, so a same-tick rewrite still reads as a change. */
function write(rel: string, content: string): void {
  fs.writeFileSync(at(rel), content);
  const later = new Date(Date.now() + 2000 + Math.random() * 1000);
  fs.utimesSync(at(rel), later, later);
}

/** Render the model as its editor's live update does. */
function render(code = modelSource()): Promise<SceneRenderedData | null> {
  return server.updateLiveCode(at('model.part.js'), code);
}

/**
 * Save a workspace file as the watcher sees it (index.ts): the server hears
 * of it, then the model renders again from the same buffer when the render
 * is behind. Answers that render, or null when none ran.
 */
async function save(rel: string, content: string, code = modelSource()): Promise<SceneRenderedData | null> {
  write(rel, content);
  server.noteFileChange(at(rel));
  return server.isRenderBehind(at(rel)) ? render(code) : null;
}

type Row = { type: string; fromCache?: boolean; hasError?: boolean; errorMessage?: string; sceneShapes?: { shapeId: string }[]; sourceLocation?: { line: number } };

function rows(data: SceneRenderedData | null, type: string): Row[] {
  return (data!.result as Row[]).filter(row => row.type === type);
}

function errorsOf(data: SceneRenderedData | null): string[] {
  return (data!.result as Row[]).flatMap(row => row.hasError ? [`${row.type}: ${row.errorMessage}`] : []);
}

/** The volume of every solid the render shows. */
function volumeOf(data: SceneRenderedData | null): number {
  return (data!.result as Row[])
    .flatMap(row => row.sceneShapes ?? [])
    .reduce((sum, shape) => sum + (server.getShapeProperties(shape.shapeId)?.volumeMm3 ?? 0), 0);
}

/** Whether each statement took its cached build, in the model's order: sketches, the plate, the collar, the standoff, the block. */
function cacheOf(data: SceneRenderedData | null) {
  const [plateSketch, blockSketch] = rows(data, 'sketch');
  const [plate, block] = rows(data, 'extrude');
  return {
    plateSketch: plateSketch.fromCache,
    plate: plate.fromCache,
    collar: rows(data, 'acme.collar')[0].fromCache,
    standoff: rows(data, 'standoff')[0].fromCache,
    blockSketch: blockSketch.fromCache,
    block: block.fromCache,
  };
}

/** The highest point of a ghost's meshes. */
function topOf(solids: { meshes: any[] }[] | undefined): number {
  let top = -Infinity;
  for (const solid of solids ?? []) {
    for (const mesh of solid.meshes) {
      const vertices = (mesh as { vertices: number[] }).vertices;
      for (let i = 2; i < vertices.length; i += 3) {
        top = Math.max(top, vertices[i]);
      }
    }
  }
  return top;
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fluidcad-feature-code-'));
  fs.writeFileSync(at('init.js'), `import { init } from 'fluidcad'\n\nexport default await init()\n`);
  write('standoff.feature.js', STANDOFF_SOURCE);
  write('collar.feature.js', COLLAR_SOURCE);
  write('collar-size.js', `export const WALL = 1;\n`);
  write('notes.js', `export const unrelated = 1;\n`);
  write('model.part.js', modelSource());
  host = new LocalSceneHost();
  server = new FluidCadServer(host);
  await server.init(root);
});

afterEach(async () => {
  await host?.server.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('a feature module saved with new code', () => {
  it('rebuilds its statements on the save\'s re-render — new geometry, the same values — and keeps what stands before them cached', async () => {
    const first = await render();
    expect(errorsOf(first)).toEqual([]);
    expect(volumeOf(first)).toBeCloseTo(PLATE + tube(12) + ring(1) + BLOCK, 3);

    const saved = await save('standoff.feature.js', STANDOFF_TALLER);
    expect(saved).not.toBeNull();
    expect(errorsOf(saved)).toEqual([]);
    // The plate's built-ins and the collar (another custom feature) stand
    // before the standoff: cache hits. The standoff rebuilds with its new
    // code, and the block after it with it — the cache is a prefix.
    expect(cacheOf(saved)).toEqual({
      plateSketch: true, plate: true, collar: true, standoff: false, blockSketch: false, block: false,
    });
    expect(volumeOf(saved)).toBeCloseTo(PLATE + tube(17) + ring(1) + BLOCK, 3);

    // One-shot: the render after it caches as before.
    const again = await render(modelSource('// a note'));
    expect(cacheOf(again)).toEqual({
      plateSketch: true, plate: true, collar: true, standoff: true, blockSketch: true, block: true,
    });
    expect(volumeOf(again)).toBeCloseTo(PLATE + tube(17) + ring(1) + BLOCK, 3);
  });

  it('rebuilds a feature whose module imports the saved helper', async () => {
    await render();
    expect(server.noteFileChange(at('notes.js'))).toBe(false);

    const saved = await save('collar-size.js', `export const WALL = 2;\n`);
    expect(saved).not.toBeNull();
    expect(errorsOf(saved)).toEqual([]);
    expect(cacheOf(saved)).toMatchObject({ plateSketch: true, plate: true, collar: false, standoff: false });
    expect(volumeOf(saved)).toBeCloseTo(PLATE + tube(12) + ring(2) + BLOCK, 3);
  });

  it('rebuilds nothing without a save: a re-render keeps every hit, and a file no feature reads changes nothing', async () => {
    await render();
    const edited = await render(modelSource('// a note'));
    expect(cacheOf(edited)).toEqual({
      plateSketch: true, plate: true, collar: true, standoff: true, blockSketch: true, block: true,
    });

    expect(await save('notes.js', `export const unrelated = 2;\n`)).toBeNull();
    const after = await render(modelSource('// another note'));
    expect(Object.values(cacheOf(after)).every(hit => hit === true)).toBe(true);
    expect(volumeOf(after)).toBeCloseTo(PLATE + tube(12) + ring(1) + BLOCK, 3);
  });

  it('redoes a render that read the new code before the watcher said it was saved', async () => {
    const code = modelSource('// typed while the save landed');
    await render();
    // The model renders between the save and the watcher's word: it reads
    // the new module, yet matches the standoff's statement to its old build.
    write('standoff.feature.js', STANDOFF_TALLER);
    const raced = await render(code);
    expect(cacheOf(raced).standoff).toBe(true);
    expect(volumeOf(raced)).toBeCloseTo(PLATE + tube(12) + ring(1) + BLOCK, 3);

    // The watcher's word: behind, though the inputs already hash as read,
    // and the same buffer renders again rather than being served the
    // stale answer.
    expect(server.noteFileChange(at('standoff.feature.js'))).toBe(true);
    expect(server.isRenderBehind(at('standoff.feature.js'))).toBe(true);
    const redone = await render(code);
    expect(cacheOf(redone)).toMatchObject({ collar: true, standoff: false });
    expect(volumeOf(redone)).toBeCloseTo(PLATE + tube(17) + ring(1) + BLOCK, 3);
  });

  it('rebuilds in every model that read the module, the one open again later too', async () => {
    write('other.part.js', modelSource('// the other model'));
    const other = () => server.processFile(at('other.part.js'));
    await other();
    await server.processFile(at('model.part.js'));

    // Both render between the save and the watcher's word: each reads the
    // new module, and each matches the standoff to its old build.
    write('standoff.feature.js', STANDOFF_TALLER);
    expect(cacheOf(await other()).standoff).toBe(true);
    expect(cacheOf(await server.processFile(at('model.part.js'))).standoff).toBe(true);

    expect(server.noteFileChange(at('standoff.feature.js'))).toBe(true);
    const model = await server.processFile(at('model.part.js'));
    expect(cacheOf(model)).toMatchObject({ collar: true, standoff: false });
    // The other model was rendered from these very files: its cached render
    // would be served as it stands, built with the old code.
    const reopened = await other();
    expect(cacheOf(reopened)).toMatchObject({ plate: true, collar: true, standoff: false });
    expect(volumeOf(reopened)).toBeCloseTo(PLATE + tube(17) + ring(1) + BLOCK, 3);
  });

  it('still rebuilds once a save that broke the render is fixed', async () => {
    await render();
    await expect(save('standoff.feature.js', `${STANDOFF_SOURCE}\nexport const broken = ;\n`)).rejects.toThrow();

    const fixed = await save('standoff.feature.js', STANDOFF_TALLER);
    expect(errorsOf(fixed)).toEqual([]);
    expect(cacheOf(fixed)).toMatchObject({ plate: true, collar: true, standoff: false });
    expect(volumeOf(fixed)).toBeCloseTo(PLATE + tube(17) + ring(1) + BLOCK, 3);
  });

  it('still rebuilds when the render that would have is the model\'s own, and fails', async () => {
    await render();
    write('standoff.feature.js', STANDOFF_TALLER);
    expect(server.noteFileChange(at('standoff.feature.js'))).toBe(true);
    // The model's own edit gets there first, and does not compile.
    await expect(render(`${modelSource()}\nconst broken = ;\n`)).rejects.toThrow();

    const fixed = await render();
    expect(errorsOf(fixed)).toEqual([]);
    expect(cacheOf(fixed)).toMatchObject({ plate: true, collar: true, standoff: false });
    expect(volumeOf(fixed)).toBeCloseTo(PLATE + tube(17) + ring(1) + BLOCK, 3);
  });

  it('draws the saved code in the next ghost, rendered again or not', async () => {
    const first = await render();
    const top = rows(first, 'select').find(row => row.sourceLocation)!.sourceLocation!.line;
    const ghost = () => server.featureGhost({
      feature: 'custom',
      modulePath: at('standoff.feature.js'),
      exportName: 'standoff',
      values: { height: 12 },
      refs: { face: [{ kind: 'statement', filePath: at('model.part.js'), line: top }] },
      operation: null,
    });

    const before = await ghost();
    expect(before.reason).toBeUndefined();
    expect(topOf(before.solids)).toBeCloseTo(5 + 12, 4);

    // Saved, and no render yet: the ghost loads the module again.
    write('standoff.feature.js', STANDOFF_TALLER);
    expect(server.noteFileChange(at('standoff.feature.js'))).toBe(true);
    const saved = await ghost();
    expect(topOf(saved.solids)).toBeCloseTo(5 + 17, 4);

    // The save's re-render leaves it so.
    expect(server.isRenderBehind(at('standoff.feature.js'))).toBe(true);
    await render();
    expect(topOf((await ghost()).solids)).toBeCloseTo(5 + 17, 4);
  });

  it('rebuilds features named by id, for a feature whose code changed with no workspace module saved', async () => {
    await render();
    server.rebuildFeatures(['acme.collar']);
    const rebuilt = await server.recomputeCurrentFile();
    expect(cacheOf(rebuilt)).toMatchObject({ plateSketch: true, plate: true, collar: false, standoff: false });
    expect(errorsOf(rebuilt)).toEqual([]);
  });
});
