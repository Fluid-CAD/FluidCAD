import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { FluidCadServer, ModelBuildTimes, ScratchBuildRefusal, ScratchBuildReport, ScratchBuildStore } from '../src/fluidcad-server/index.ts';
import type { ScratchBuildMeshes, ScratchBuildOutcome, ScratchBuildReuse } from '../src/fluidcad-server/index.ts';
import { LocalSceneHost } from '../src/host/local-scene-host.ts';
import type { RenderOverlay, SceneHost } from '../src/host/scene-host.ts';
import { createManager, getSceneManager } from '../../lib/dist/scene-manager.js';
import { getParamRegistry } from '../../lib/dist/index.js';
import param from '../../lib/dist/core/param.js';
import part from '../../lib/dist/core/part.js';
import configurations from '../../lib/dist/core/configurations.js';

// A scratch build (`FluidCadServer.scratchBuild`): a candidate version of a
// model file built in a throwaway scene and reported — never written, never
// the session's scene. Over a real workspace and engine: the facts are the
// kernel's, and everything live is compared before and after. The engine a
// workspace loads there is Node's own copy of the library while this file's
// imports are the test runner's, so what goes through the param registry
// (overrides, configurations, per-build params) is tested further down
// against a host that evaluates with the runner's copy.

/** A 40 × 40 block, `Height` tall; `fillet` rounds its top edges when set. */
function block(options: { height?: number; fillet?: number; extra?: string } = {}): string {
  const { height = 30, fillet, extra = '' } = options;
  return [
    `import { extrude, fillet, line, param, part, sketch, xAxis, yAxis } from 'fluidcad/core';`,
    `import { coincident, distance, horizontal, symmetric, vertical } from 'fluidcad/constraints';`,
    extra,
    `export const block = part('Block', () => {`,
    `  const height = param('Height', ${height});`,
    `  sketch('xy', () => {`,
    `    const b = line([-20, -20], [20, -20]);`,
    `    const r = line([20, -20], [20, 20]);`,
    `    const t = line([20, 20], [-20, 20]);`,
    `    const l = line([-20, 20], [-20, -20]);`,
    `    coincident(b.end(), r.start());`,
    `    coincident(r.end(), t.start());`,
    `    coincident(t.end(), l.start());`,
    `    coincident(l.end(), b.start());`,
    `    horizontal(t);`,
    `    vertical(l);`,
    `    symmetric(b.start(), b.end(), yAxis());`,
    `    symmetric(r.start(), r.end(), xAxis());`,
    `    distance(b.start(), b.end(), 40);`,
    `    distance(r.start(), r.end(), 40);`,
    `  });`,
    `  const e = extrude(height);`,
    fillet === undefined ? '' : `  fillet(${fillet}, e.endEdges());`,
    `});`,
    ``,
  ].join('\n');
}

async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const table = vi.spyOn(console, 'table').mockImplementation(() => {});
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    return await fn();
  } finally {
    log.mockRestore();
    table.mockRestore();
    warn.mockRestore();
  }
}

type Built = Exclude<ScratchBuildOutcome, { state: 'compile-error' }>;

describe('a scratch build over a workspace', () => {
  let root: string;
  let file: string;
  let host: LocalSceneHost;
  let server: FluidCadServer;
  /** Module evaluations: every render and every scratch build evaluates the file once. */
  let evaluations = 0;

  const build = (request: { file?: string; source?: string; params?: Record<string, unknown>; reuse?: boolean } = {}) =>
    quietly(() => server.scratchBuild({ file, ...request })) as Promise<ScratchBuildOutcome>;
  const built = async (request: { file?: string; source?: string; params?: Record<string, unknown>; reuse?: boolean } = {}): Promise<Built> => {
    const outcome = await build(request);
    if (outcome.state === 'compile-error') {
      throw new Error(`did not evaluate: ${outcome.compileError.message}`);
    }
    return outcome;
  };
  /** Everything a scratch build must leave as it found it. */
  const live = () => ({
    current: server.getCurrentFileName(),
    code: server.getCurrentCode(),
    disk: fs.readFileSync(file, 'utf8'),
    objects: server.getSceneSummary()?.objects.map(o => [o.id, o.name, o.shapeIds]),
    params: server.getParamDefinitions().map(p => [p.label, p.currentValue]),
    overrides: server.getParamOverrides(file),
    compileError: server.getCompileError(),
    registry: getParamRegistry(),
    dependencies: host.getModuleDependencies(file).slice().sort(),
    files: fs.readdirSync(root).filter(name => name !== 'node_modules').sort(),
  });

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fluidcad-scratch-build-')).replace(/\\/g, '/');
    fs.writeFileSync(path.join(root, 'init.js'), `import { init } from 'fluidcad'\n\nexport default await init()\n`);
    fs.writeFileSync(path.join(root, 'helper.js'), `export const EXTRA = 12;\n`);
    file = `${root}/block.part.js`;
    fs.writeFileSync(file, block());
    host = new LocalSceneHost();
    server = new FluidCadServer(host);
    await quietly(() => server.init(root));
    const load = host.loadModule.bind(host);
    host.loadModule = async (...args) => {
      evaluations++;
      return load(...args);
    };
    const opened = await quietly(() => server.updateLiveCode(file, block()));
    expect(opened?.objectErrors).toEqual([]);
  });

  afterAll(async () => {
    await host?.server?.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reports the file as it is: one sound solid, its volume and bounds, and meshes under its id', async () => {
    const outcome = await built();
    expect(outcome).toMatchObject({
      state: 'rendered',
      file,
      sceneKind: 'part',
      unit: 'mm',
      builtFrom: 'buffer',
      configuration: 'Default',
      sessionOverrides: 0,
      unusedParams: [],
      solidCount: 1,
      volume: 48000,
      bounds: { min: [-20, -20, 0], max: [20, 20, 30] },
      validation: { ok: true, checked: 1, findings: [], skipped: 0 },
    });
    const meshes = server.scratchBuilds.get(outcome.id) as ScratchBuildMeshes;
    expect(meshes).toMatchObject({ id: outcome.id, file, sceneKind: 'part', unit: 'mm' });
    // The rows a page draws: the part with its features under it, the solid meshed.
    const part = meshes.objects.find(row => row.type === 'part');
    expect(part.parentId).toBeNull();
    expect(meshes.objects.some(row => row.parentId === part.id)).toBe(true);
    const solids = ScratchBuildReport.solidsOf(meshes.objects);
    expect(solids).toHaveLength(1);
    expect(solids[0].meshes.length).toBeGreaterThan(0);
    expect(solids[0].meshes[0].vertices.length).toBeGreaterThan(0);
    expect(meshes.objects.every(row => !row.sourceLocation || row.sourceLocation.filePath === file)).toBe(true);
  });

  it('builds a candidate source without touching anything live', async () => {
    const before = live();
    const evaluated = evaluations;

    const taller = await built({ source: block({ height: 60 }) });
    expect(taller).toMatchObject({ state: 'rendered', builtFrom: 'source', volume: 96000, bounds: { min: [-20, -20, 0], max: [20, 20, 60] } });

    const rounded = await built({ source: block({ fillet: 5 }) });
    expect(rounded.state).toBe('rendered');
    expect(rounded.volume).toBeGreaterThan(40000);
    expect(rounded.volume).toBeLessThan(48000);
    expect(rounded.validation?.ok).toBe(true);

    expect(evaluations).toBe(evaluated + 2);
    expect(live()).toEqual(before);
    // The session's own render is still the one served: the same code
    // evaluates nothing.
    await quietly(() => server.updateLiveCode(file, block()));
    expect(evaluations).toBe(evaluated + 2);
    expect(live()).toEqual(before);
  });

  it('answers a feature that fails to build as a build-error, with the failed feature and what did build', async () => {
    const before = live();
    const outcome = await built({ source: block({ fillet: 400 }) });
    expect(outcome.state).toBe('build-error');
    const errors = (outcome as Extract<Built, { state: 'build-error' }>).objectErrors;
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ uniqueKind: expect.stringContaining('fillet'), sourceLocation: { filePath: file } });
    expect(errors[0].message.length).toBeGreaterThan(0);
    // The block itself built: the facts are of the scene without the fillet.
    expect(outcome).toMatchObject({ solidCount: 1, volume: 48000 });
    expect(server.scratchBuilds.get(outcome.id)).not.toBeNull();
    expect(live()).toEqual(before);
  });

  it('answers a candidate that does not evaluate as a compile-error, with no meshes', async () => {
    const before = live();
    const stored = server.scratchBuilds.stats().builds;
    const broken = await build({ source: block().replace(`const e = extrude(height);`, `const e = extrude(height;`) });
    expect(broken.state).toBe('compile-error');
    expect((broken as Extract<ScratchBuildOutcome, { state: 'compile-error' }>).compileError).toMatchObject({ filePath: file });

    const thrown = await build({ source: block({ extra: `nowhere();` }) });
    expect(thrown).toMatchObject({ state: 'compile-error', compileError: { message: expect.stringContaining('nowhere') } });

    const blocked = await build({ source: block({ extra: `import fs from 'fs';` }) });
    expect(blocked.state).toBe('compile-error');

    expect(server.scratchBuilds.stats().builds).toBe(stored);
    expect(live()).toEqual(before);
  });

  it('puts the file\'s imports back as the loader listed them', async () => {
    const helper = `${root}/helper.js`;
    const before = live();
    const outcome = await built({ source: block({ extra: `import { EXTRA } from './helper.js';`, height: 12 }) });
    expect(outcome.volume).toBe(19200);
    expect(host.getModuleImporters(helper)).toEqual([]);
    expect(live()).toEqual(before);
  });

  it('answers a kept build of the same inputs when asked to reuse, and builds when anything it read changed', async () => {
    const helper = `${root}/helper.js`;
    const source = block({ extra: `import { EXTRA } from './helper.js';`, height: 18 });
    const first = await built({ source, reuse: true });
    expect(first.reused).toBeUndefined();
    const evaluated = evaluations;

    // The same text again: the kept build, nothing evaluated, its meshes still served.
    const again = await built({ source, reuse: true });
    expect(again).toMatchObject({ reused: true, id: first.id, volume: first.volume, geometry: first.geometry });
    expect(evaluations).toBe(evaluated);
    expect(server.scratchBuilds.get(first.id)).not.toBeNull();
    // Without `reuse` a build is always made.
    expect((await built({ source })).reused).toBeUndefined();
    expect(evaluations).toBe(evaluated + 1);

    // Another text, other params, or a module the build imported that has changed: a build.
    expect((await built({ source: `${source}// a note\n`, reuse: true })).reused).toBeUndefined();
    expect((await built({ source, params: { Height: 5 }, reuse: true })).reused).toBeUndefined();
    expect((await built({ source, reuse: true })).reused).toBe(true);
    fs.writeFileSync(helper, `export const EXTRA = 13;\n`);
    try {
      const changed = await built({ source, reuse: true });
      expect(changed.reused).toBeUndefined();
      expect(changed.id).not.toBe(first.id);
    } finally {
      fs.writeFileSync(helper, `export const EXTRA = 12;\n`);
    }
    // A candidate that does not evaluate is never kept.
    const broken = block().replace(`const e = extrude(height);`, `const e = extrude(height;`);
    expect((await build({ source: broken, reuse: true })).state).toBe('compile-error');
    expect((await build({ source: broken, reuse: true })).state).toBe('compile-error');
  });

  it('says what a build would cost without building: the kept build, or how long the file last took', async () => {
    const source = block({ height: 21 });
    const evaluated = evaluations;
    const unknown = await server.scratchBuildCost({ file, source });
    expect(unknown?.reusable).toBeNull();
    // The file was rendered when the suite opened it, and built since.
    expect(unknown?.lastBuildMs).toEqual(expect.any(Number));
    const outcome = await built({ source });
    const known = await server.scratchBuildCost({ file, source });
    expect(known?.reusable).toMatchObject({ reused: true, id: outcome.id, volume: 33600 });
    expect(known?.lastBuildMs).toBe(outcome.durationMs);
    expect(evaluations).toBe(evaluated + 1);
    // A file nothing was built of yet.
    expect(await server.scratchBuildCost({ file: `${root}/never.part.js`, source })).toEqual({ reusable: null, lastBuildMs: null });
    await expect(server.scratchBuildCost({ file: `${root}/helper.js` })).rejects.toBeInstanceOf(ScratchBuildRefusal);
  });

  it('digests what a build draws: the same for a comment or a rename, another for a change of shape', async () => {
    const plain = await built({ source: block() });
    const commented = await built({ source: `// The block, 30 tall.\n${block()}` });
    const renamed = await built({ source: block().replace(`part('Block'`, `part('Brick'`) });
    const moved = await built({ source: block().replace(`const e = extrude(height);`, `const e = extrude(height);\n  // nothing more`) });
    expect(plain.geometry).toMatch(/^[0-9a-f]{40}$/);
    expect(commented.geometry).toBe(plain.geometry);
    expect(renamed.geometry).toBe(plain.geometry);
    expect(moved.geometry).toBe(plain.geometry);
    expect((await built({ source: block({ fillet: 5 }) })).geometry).not.toBe(plain.geometry);
    expect((await built({ source: block({ height: 31 }) })).geometry).not.toBe(plain.geometry);
  });

  it('bounds a curved body exactly, and builds a model of bare statements', async () => {
    const outcome = await built({
      file: `${root}/dowel.fluid.js`,
      source: `import { cylinder } from 'fluidcad/core';\ncylinder(10, 50);\n`,
    });
    expect(outcome).toMatchObject({ state: 'rendered', solidCount: 1, bounds: { min: [-10, -10, 0], max: [10, 10, 50] } });
    expect(outcome.volume).toBeCloseTo(Math.PI * 100 * 50, 2);
    // No part row: the rows a page draws are the scene's roots.
    const meshes = server.scratchBuilds.get(outcome.id)!;
    expect(meshes.objects.filter(row => !row.parentId).map(row => row.type)).toEqual(['cylinder']);
  });

  it('builds an assembly: every instance counted and bounded where it sits, the instances with the meshes', async () => {
    const before = live();
    const outcome = await built({
      file: `${root}/pair.assembly.js`,
      source: [
        `import { assembly, insert } from 'fluidcad/core';`,
        `import { block } from './block.part.js';`,
        `export const pair = assembly('pair', () => {`,
        `  const a = insert(block).grounded();`,
        `  const b = insert(block).translate(100, 0, 0);`,
        `});`,
        ``,
      ].join('\n'),
    });
    expect(outcome).toMatchObject({
      state: 'rendered',
      sceneKind: 'assembly',
      instanceCount: 2,
      solidCount: 2,
      volume: 96000,
      bounds: { min: [-20, -20, 0], max: [120, 20, 30] },
      validation: { ok: true, checked: 1 },
    });
    const meshes = server.scratchBuilds.get(outcome.id)!;
    expect(meshes.assembly?.instances.map(instance => instance.position.x)).toEqual([0, 100]);
    // One part template, drawn once per instance.
    const templates = meshes.objects.filter(row => row.type === 'part');
    expect(templates).toHaveLength(1);
    expect(meshes.assembly?.instances.every(instance => instance.partId === templates[0].id)).toBe(true);
    expect(live()).toEqual(before);
  });

  it('builds a file that does not exist yet from its source, and refuses what it cannot build', async () => {
    const fresh = `${root}/fresh.part.js`;
    const before = live();
    expect(await built({ file: fresh, source: block({ height: 5 }) })).toMatchObject({ state: 'rendered', file: fresh, volume: 8000 });
    expect(fs.existsSync(fresh)).toBe(false);
    expect(live()).toEqual(before);

    await expect(server.scratchBuild({ file: fresh })).rejects.toMatchObject({ status: 404 });
    await expect(server.scratchBuild({ file: `${root}/helper.js`, source: '' })).rejects.toBeInstanceOf(ScratchBuildRefusal);
    await expect(server.scratchBuild({ file: `${root}/helper.js`, source: '' })).rejects.toMatchObject({ status: 422 });
  });
});

/**
 * A host that "evaluates" a buffer the way configurations-session.test.ts
 * does: one part body declaring the table and every `param("label", n)` of
 * the text it was handed — the render overlay's when one is set. Each run
 * records the values its params resolved to.
 */
class ParamHost implements SceneHost {
  buffers = new Map<string, string>();
  overlay: RenderOverlay | null = null;
  overlaysSet = 0;
  runs: Record<string, unknown>[] = [];
  loaded: string[] = [];

  async init(): Promise<void> {}

  async loadModule(filePath: string): Promise<Record<string, any>> {
    this.loaded.push(filePath);
    const file = filePath.replace('virtual:live-render:', '');
    const code = this.overlay?.code.get(file) ?? this.buffers.get(`virtual:live-render:${file}`) ?? '';
    const scene = (getSceneManager() ?? createManager('')).startScene();
    const values: Record<string, unknown> = {};
    part('Model', () => {
      configurations({ Tall: { Height: 90 } });
      for (const m of code.matchAll(/param\("([^"]+)",\s*([\d.]+)\)/g)) {
        values[m[1]] = param(m[1], Number(m[2]));
      }
    });
    scene.materializeLeftoverDefinitions();
    this.runs.push(values);
    return {};
  }

  setBuffer(id: string, code: string): void {
    this.buffers.set(id, code);
  }

  getBuffer(fileName: string): string | null {
    return this.buffers.get(`virtual:live-render:${fileName}`) ?? null;
  }

  invalidateModule(): void {}

  setRenderOverlay(overlay: RenderOverlay | null): void {
    this.overlay = overlay;
    if (overlay) {
      this.overlaysSet++;
    }
  }
}

describe('a scratch build and the file\'s session', () => {
  const FILE = '/ws/model.part.js';
  const SOURCE = 'const height = param("Height", 30)\nconst width = param("Width", 40)';
  let host: ParamHost;
  let server: FluidCadServer;
  let disposed: number;
  let scenes: number;
  let liveScene: unknown;

  beforeEach(async () => {
    host = new ParamHost();
    server = new FluidCadServer(host);
    disposed = 0;
    scenes = 0;
    const manager = {
      currentScene: null as unknown,
      currentFile: '',
      startScene() {
        scenes++;
        manager.currentScene = { getRenderedObjects: () => [], getAllSceneObjects: () => [] };
        return manager.currentScene;
      },
      startAssemblyScene: () => manager.startScene(),
      setCurrentFile(file: string) {
        manager.currentFile = file;
      },
      renderScene() {},
      compare: (_previous: unknown, next: unknown) => next,
      getAssemblyData: () => null,
      disposeScene() {
        disposed++;
      },
    };
    server.setSceneManager(manager as any);
    await server.updateLiveCode(FILE, SOURCE);
    liveScene = manager.currentScene;
    (server as any).__manager = manager;
  });

  const lastRun = () => host.runs.at(-1);
  const build = (request: { source?: string; params?: Record<string, unknown> } = {}) =>
    server.scratchBuild({ file: FILE, ...request }) as Promise<Exclude<ScratchBuildOutcome, { state: 'compile-error' }>>;

  it('evaluates the candidate through the render overlay under the file\'s live-render id, then frees its scene', async () => {
    const outcome = await build({ source: 'const height = param("Height", 55)' });
    expect(outcome.state).toBe('rendered');
    expect(lastRun()).toEqual({ Height: 55 });
    expect(host.loaded.at(-1)).toBe(`virtual:live-render:${FILE}`);
    expect(host.overlaysSet).toBe(1);
    expect(host.overlay).toBeNull();
    expect(disposed).toBe(1);
    // The buffer the editor holds is still its own.
    expect(server.getCurrentCode()).toBe(SOURCE);
  });

  it('applies params to this build only, and names the ones nothing declared', async () => {
    const outcome = await build({ params: { Height: 10, Missing: 3 } });
    expect(lastRun()).toEqual({ Height: 10, Width: 40 });
    expect(outcome).toMatchObject({ unusedParams: ['Missing'], sessionOverrides: 0, configuration: 'Default' });
    expect(server.getParamOverrides(FILE)).toEqual({});

    await build();
    expect(lastRun()).toEqual({ Height: 30, Width: 40 });
  });

  it('builds as the session renders: its overrides and configuration apply, a re-declared literal wins, params win over both', async () => {
    expect(server.setParam(FILE, 'Height', 45)).toBeNull();
    await server.updateLiveCode(FILE, SOURCE);
    expect(lastRun()).toEqual({ Height: 45, Width: 40 });
    const registry = getParamRegistry();
    const manager = (server as any).__manager;
    liveScene = manager.currentScene;

    expect(await build()).toMatchObject({ sessionOverrides: 1, configuration: 'Default' });
    expect(lastRun()).toEqual({ Height: 45, Width: 40 });
    // The candidate re-declares the default the override was made against:
    // the override is stale for this build, and stays the session's.
    await build({ source: SOURCE.replace('30', '50') });
    expect(lastRun()).toEqual({ Height: 50, Width: 40 });
    await build({ source: SOURCE.replace('30', '50'), params: { Height: 20 } });
    expect(lastRun()).toEqual({ Height: 20, Width: 40 });

    expect(server.getParamOverrides(FILE)).toEqual({ Height: 45 });
    expect(getParamRegistry()).toBe(registry);
    expect(manager.currentScene).toBe(liveScene);
    expect(manager.currentFile).toBe(FILE);
    expect(server.getParamDefinitions().map(p => [p.label, p.currentValue])).toEqual([['Height', 45], ['Width', 40]]);

    // The configuration the session shows is the build's; the override sits on it.
    server.selectConfiguration(FILE, 'Tall');
    await server.updateLiveCode(FILE, SOURCE);
    expect(lastRun()).toEqual({ Height: 90, Width: 40 });
    expect(await build()).toMatchObject({ configuration: 'Tall', sessionOverrides: 0 });
    expect(lastRun()).toEqual({ Height: 90, Width: 40 });
    expect(server.getActiveConfiguration(FILE)).toBe('Tall');
  });

  it('leaves the dedup entry in place: the same code renders nothing after a scratch build', async () => {
    const runs = host.runs.length;
    await build({ source: 'const height = param("Height", 99)' });
    expect(host.runs.length).toBe(runs + 1);
    await server.updateLiveCode(FILE, SOURCE);
    expect(host.runs.length).toBe(runs + 1);
  });

  it('refuses a host that cannot evaluate text it does not hold', async () => {
    (host as any).setRenderOverlay = undefined;
    await expect(server.scratchBuild({ file: FILE, source: SOURCE })).rejects.toMatchObject({ status: 501 });
  });
});

describe('ScratchBuildStore', () => {
  const meshesOf = (id: string, numbers: number): ScratchBuildMeshes => ({
    id,
    file: '/ws/a.part.js',
    sceneKind: 'part',
    unit: 'mm',
    objects: [{ id: 'row', sceneShapes: [{ shapeType: 'solid', meshes: [{ vertices: new Array(numbers).fill(0) }] }] }],
  });

  it('keeps the newest builds, by count', () => {
    const store = new ScratchBuildStore();
    for (let i = 0; i < ScratchBuildStore.MAX_BUILDS + 3; i++) {
      store.put(meshesOf(`build-${i}`, 3));
    }
    expect(store.stats().builds).toBe(ScratchBuildStore.MAX_BUILDS);
    expect(store.get('build-0')).toBeNull();
    expect(store.get(`build-${ScratchBuildStore.MAX_BUILDS + 2}`)?.id).toBe(`build-${ScratchBuildStore.MAX_BUILDS + 2}`);
  });

  it('keeps the newest build whatever it weighs, and older ones while they fit', () => {
    const store = new ScratchBuildStore();
    store.put(meshesOf('small', 10));
    store.put(meshesOf('heavy', ScratchBuildStore.MAX_OLDER_WEIGHT + 1));
    expect(store.get('heavy')).not.toBeNull();
    expect(store.get('small')).not.toBeNull();
    // The heavy one is now an older build, and past what older builds may weigh.
    store.put(meshesOf('next', 10));
    expect(store.get('next')).not.toBeNull();
    expect(store.get('heavy')).toBeNull();
    expect(store.get('small')).toBeNull();
  });

  it('lets a build go once it is too old, the newest excepted', () => {
    let now = 0;
    const store = new ScratchBuildStore(() => now);
    store.put(meshesOf('first', 3));
    now += 1000;
    store.put(meshesOf('second', 3));
    now += ScratchBuildStore.MAX_AGE_MS;
    expect(store.get('first')).toBeNull();
    expect(store.get('second')).not.toBeNull();
    now += ScratchBuildStore.MAX_AGE_MS;
    expect(store.get('second')).not.toBeNull();
  });

  it('finds a kept build by the inputs it was made from, and keeps a reused one as if just made', () => {
    let now = 0;
    const store = new ScratchBuildStore(() => now);
    const reuse = (id: string, key: string): ScratchBuildReuse =>
      ({ key, outcome: { state: 'rendered', id } as ScratchBuildReuse['outcome'], fingerprint: { files: new Map(), params: '' } });
    store.put(meshesOf('first', 3), reuse('first', 'key-a'));
    now += 1000;
    store.put(meshesOf('plain', 3));
    store.put(meshesOf('second', 3), reuse('second', 'key-b'));
    expect(store.find('key-a')?.outcome.id).toBe('first');
    expect(store.find('key-b')?.outcome.id).toBe('second');
    expect(store.find('key-c')).toBeNull();
    // The same inputs built again: the newer build answers.
    store.put(meshesOf('third', 3), reuse('third', 'key-a'));
    expect(store.find('key-a')?.outcome.id).toBe('third');

    // Reused just before it would be let go: kept for another half hour.
    now += ScratchBuildStore.MAX_AGE_MS - 500;
    store.touch('first');
    now += 1000;
    expect(store.get('first')).not.toBeNull();
    expect(store.find('key-a')?.outcome.id).toBe('first');
    expect(store.get('second')).toBeNull();
    expect(store.find('key-b')).toBeNull();
    store.touch('gone');
    expect(store.stats().builds).toBe(1);
  });

  it('knows the form of its ids', () => {
    expect(ScratchBuildStore.isId(ScratchBuildStore.newId())).toBe(true);
    expect(ScratchBuildStore.isId('../etc/passwd')).toBe(false);
    expect(ScratchBuildStore.isId(undefined)).toBe(false);
  });
});

describe('ScratchBuildReport', () => {
  const solid = (vertices: number[]) => ({ shapeType: 'solid', meshes: [{ vertices }] });

  it('reads the solids on screen off the rows, and nothing else', () => {
    const objects = [
      { id: 'a', sceneShapes: [solid([0, 0, 0, 10, 20, 30])] },
      { id: 'hidden', visible: false, sceneShapes: [solid([-100, 0, 0])] },
      { id: 'sketch', sceneShapes: [{ shapeType: 'wire', meshes: [{ vertices: [500, 0, 0] }] }] },
      { id: 'meta', sceneShapes: [{ ...solid([900, 0, 0]), isMetaShape: true }] },
    ];
    expect(ScratchBuildReport.solidsOf(objects)).toEqual([objects[0].sceneShapes[0]]);
  });

  it('counts solids and sums volume from the validator\'s shapes, once per instance in an assembly', () => {
    const report = {
      ok: true, checked: 2, findings: [], skipped: [], checks: [], notChecked: {}, unit: 'mm',
      shapes: [
        { shapeId: 's1', solids: 1, volume: 100, instanceIds: ['i1', 'i2'] },
        { shapeId: 's2', solids: 2, volume: 30, instanceIds: ['i3'] },
      ],
    } as any;
    expect(ScratchBuildReport.solids([], report, false)).toEqual({ solidCount: 3, volume: 130 });
    expect(ScratchBuildReport.solids([], report, true)).toEqual({ solidCount: 4, volume: 230 });
    expect(ScratchBuildReport.solids([{ sceneShapes: [solid([0, 0, 0])] }], null, false)).toEqual({ solidCount: 1, volume: null });
    expect(ScratchBuildReport.validation(null)).toBeNull();
  });
});

describe('ModelBuildTimes', () => {
  it('answers the last full build of a file, unless a later render alone took longer', () => {
    const times = new ModelBuildTimes();
    expect(times.of('/ws/a.part.js')).toBeNull();
    times.noteRender('/ws/a.part.js', 120.4);
    expect(times.of('/ws/a.part.js')).toBe(120);
    times.noteFull('/ws/a.part.js', 900);
    expect(times.of('/ws/a.part.js')).toBe(900);
    // A render that reused most of the model says nothing against the full build.
    times.noteRender('/ws/a.part.js', 40);
    expect(times.of('/ws/a.part.js')).toBe(900);
    times.noteRender('/ws/a.part.js', 2600);
    expect(times.of('/ws/a.part.js')).toBe(2600);
    // The newest full build is what a build costs now.
    times.noteFull('/ws/a.part.js', 300);
    expect(times.of('/ws/a.part.js')).toBe(300);
    expect(times.of('/ws/b.part.js')).toBeNull();
  });

  it('remembers a bounded number of files', () => {
    const times = new ModelBuildTimes();
    for (let i = 0; i <= ModelBuildTimes.MAX_FILES; i++) {
      times.noteFull(`/ws/${i}.part.js`, i);
    }
    expect(times.of('/ws/0.part.js')).toBeNull();
    expect(times.of(`/ws/${ModelBuildTimes.MAX_FILES}.part.js`)).toBe(ModelBuildTimes.MAX_FILES);
  });
});
