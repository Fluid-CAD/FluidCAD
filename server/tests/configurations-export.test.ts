import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'http';
import { mkdtempSync, rmSync, realpathSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import JSZip from 'jszip';
import { FluidCadServer } from '../src/fluidcad-server/index.ts';
import type { SceneHost } from '../src/host/scene-host.ts';
import { createExportRouter } from '../src/routes/export.ts';
import { createScreenshotRouter } from '../src/routes/screenshot.ts';
import { createConfigurationScreenshot } from '../src/routes/screenshot-configuration.ts';
import { createSceneRouter } from '../src/routes/scene.ts';
import { createPackRouter } from '../src/routes/pack.ts';
import { packModel } from '../src/model-package/pack.ts';
import { createManager, getSceneManager } from '../../lib/dist/scene-manager.js';
import { getParamRegistry } from '../../lib/dist/index.js';
import param from '../../lib/dist/core/param.js';
import part from '../../lib/dist/core/part.js';
import configurations from '../../lib/dist/core/configurations.js';
import { normalizePath } from '../src/normalize-path.ts';

// Export, screenshot, scene summary and package by configuration
// (docs/assembly-configurations-plan.md §3.7): an export of a row other than
// the one on screen is a scratch render that leaves the session alone; a
// screenshot switches the session for the capture and puts it back.

/**
 * The Vite host stand-in of configurations-session.test.ts: a run is one
 * part body declaring the table and every `param("label", n)` of the
 * buffer. Each run records the values its params resolved to.
 */
class FakeHost implements SceneHost {
  buffers = new Map<string, string>();
  moduleRuns = 0;
  invalidations = 0;
  runs: Record<string, unknown>[] = [];

  async init(): Promise<void> {}

  async loadModule(filePath: string): Promise<Record<string, any>> {
    this.moduleRuns++;
    const code = this.buffers.get(filePath) ?? this.buffers.get(`virtual:live-render:${filePath}`) ?? '';
    const scene = (getSceneManager() ?? createManager('')).startScene();
    const values: Record<string, unknown> = {};
    part('Model', () => {
      configurations({ Compact: { width: 500 }, Wide: { width: 1200 } });
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
    return this.buffers.get(fileName) ?? null;
  }

  invalidateModule(): void {
    this.invalidations++;
  }
}

type FakeScene = { no: number; getRenderedObjects: () => any[]; getAllSceneObjects: () => any[] };

/**
 * The engine side: every scene a numbered stub whose one solid has the
 * lineage key every render shares and an id minted per scene, as a real
 * render mints them. Exports and disposals are recorded by scene number.
 */
function makeFakeManager() {
  let counter = 0;
  const manager = {
    currentScene: null as FakeScene | null,
    currentFile: '',
    renderInputs: new Set<string>(),
    rendered: [] as number[],
    disposed: [] as number[],
    exported: [] as { scene: number; shapeIds: string[] }[],
    assemblies: [] as { scene: number; livePoses: unknown }[],
    startScene(): FakeScene {
      const no = ++counter;
      const scene: FakeScene = {
        no,
        getRenderedObjects: () => [{ id: `o${no}`, sceneShapes: [{ shapeId: `s${no}`, lineageKey: 'Extrude#1' }] }],
        getAllSceneObjects: () => [],
      };
      manager.currentScene = scene;
      manager.renderInputs = new Set();
      return scene;
    },
    startAssemblyScene(): FakeScene {
      return manager.startScene();
    },
    setCurrentFile(file: string) {
      manager.currentFile = file;
    },
    renderScene(scene: FakeScene) {
      manager.rendered.push(scene.no);
    },
    compare: (_prev: any, next: any) => next,
    getAssemblyData: () => null,
    disposeScene(scene: FakeScene) {
      manager.disposed.push(scene.no);
    },
    exportShapes(scene: FakeScene, shapeIds: string[]) {
      manager.exported.push({ scene: scene.no, shapeIds });
      return { data: 'solid', fileName: 'model.step' };
    },
    exportAssembly(scene: FakeScene, options: { livePoses?: unknown }) {
      manager.assemblies.push({ scene: scene.no, livePoses: options.livePoses });
      return { ok: true, data: 'ISO-10303-21;', fileName: 'rig.step', posesSource: options.livePoses ? 'live' : 'statement' };
    },
  };
  return manager;
}

const SOURCE = 'const width = param("width", 700)\nconst depth = param("depth", 800)';

let ws: string;
let file: string;
let host: FakeHost;
let manager: ReturnType<typeof makeFakeManager>;
let fluid: FluidCadServer;

beforeEach(async () => {
  ws = normalizePath(realpathSync(mkdtempSync(join(tmpdir(), 'fluidcad-config-export-'))));
  file = `${ws}/model.fluid.js`;
  host = new FakeHost();
  fluid = new FluidCadServer(host);
  await fluid.init(ws);
  manager = makeFakeManager();
  fluid.setSceneManager(manager as any);
});

afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
});

/** First render (scene 1) on the Compact row with a width tweak on top. */
async function renderTweakedCompact(): Promise<void> {
  await fluid.updateLiveCode(file, SOURCE);
  fluid.selectConfiguration(file, 'Compact');
  fluid.setParam(file, 'depth', 650);
  await fluid.updateLiveCode(file, SOURCE);
}

describe('renderWithConfiguration — a scratch render for an export', () => {
  it('renders the row without the session layer and leaves the session untouched', async () => {
    await renderTweakedCompact();
    const liveScene = manager.currentScene;
    const liveRegistry = getParamRegistry();
    const runsBefore = host.moduleRuns;

    const scratch = await fluid.renderWithConfiguration(file, 'Wide');
    expect(scratch?.ok).toBe(true);
    if (!scratch?.ok) return;

    // The row's cells, the literals elsewhere — no session tweak.
    expect(host.runs.at(-1)).toEqual({ width: 1200, depth: 800 });
    expect(scratch.configurations).toMatchObject({ active: 'Wide', names: ['Compact', 'Wide'] });
    expect(manager.rendered).toContain((scratch.scene as FakeScene).no);

    // Session: active row, overrides, configurations, the live scene the
    // viewer shows, the module-side registries and the manager's scene.
    expect(fluid.getActiveConfiguration(file)).toBe('Compact');
    expect(fluid.getParamOverrides(file)).toEqual({ depth: 650 });
    expect(fluid.getConfigurations(file)).toMatchObject({ active: 'Compact', modified: true });
    expect(getParamRegistry()).toBe(liveRegistry);
    expect(manager.currentScene).toBe(liveScene);
    expect(manager.currentFile).toBe(file);
    expect(fluid.getCurrentFileName()).toBe(file);

    // The dedup cache still answers the same code without a module run.
    const again = await fluid.updateLiveCode(file, SOURCE);
    expect(host.moduleRuns).toBe(runsBefore + 1);
    expect(again?.configurations).toMatchObject({ active: 'Compact', modified: true });

    // The caller owns the scratch scene; nothing else frees it.
    expect(manager.disposed).not.toContain((scratch.scene as FakeScene).no);
    scratch.dispose();
    expect(manager.disposed).toEqual([(scratch.scene as FakeScene).no]);
  });

  it('drops the module cache after the scratch evaluation, so the next render reloads', async () => {
    await renderTweakedCompact();
    const before = host.invalidations;
    const scratch = await fluid.renderWithConfiguration(file, 'Default');
    expect(scratch?.ok).toBe(true);
    expect(host.runs.at(-1)).toEqual({ width: 700, depth: 800 });
    // One before the load (as a render does), one after it.
    expect(host.invalidations).toBe(before + 2);
    if (scratch?.ok) scratch.dispose();
  });

  it('answers ok:false with the declared names for an unknown row, without rendering', async () => {
    await fluid.updateLiveCode(file, SOURCE);
    const runs = host.moduleRuns;
    const scratch = await fluid.renderWithConfiguration(file, 'Huge');
    expect(scratch).toEqual({ ok: false, reason: expect.stringMatching(/Unknown configuration 'Huge'.*'Compact', 'Wide'/), names: ['Compact', 'Wide'] });
    expect(host.moduleRuns).toBe(runs);
  });

  it('is null before the file has rendered', async () => {
    expect(await fluid.renderWithConfiguration(file, 'Wide')).toBeNull();
  });
});

/** An express app over `routers`, listening on a free port; returns its base URL and closer. */
async function listen(...routers: express.Router[]): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  for (const router of routers) {
    app.use('/api', router);
  }
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function post(url: string, body: unknown): Promise<{ status: number; body: any; headers: Headers }> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  let parsed: any = text;
  try { parsed = JSON.parse(text); } catch { /* binary */ }
  return { status: res.status, body: parsed, headers: res.headers };
}

describe('POST /api/export with a configuration', () => {
  let app: { url: string; close: () => Promise<void> };

  beforeEach(async () => {
    app = await listen(createExportRouter(fluid, ws));
  });

  afterEach(async () => {
    await app.close();
  });

  it('exports another row from a scratch scene, mapping the live ids onto it, then disposes it', async () => {
    await renderTweakedCompact();
    const live = manager.currentScene!;
    const res = await post(`${app.url}/api/export`, { format: 'step', shapeIds: [`s${live.no}`], configuration: 'Wide' });
    expect(res.status).toBe(200);
    expect(manager.exported).toHaveLength(1);
    const { scene, shapeIds } = manager.exported[0];
    expect(scene).not.toBe(live.no);
    expect(shapeIds).toEqual([`s${scene}`]);
    expect(manager.disposed).toEqual([scene]);
    expect(fluid.getActiveConfiguration(file)).toBe('Compact');
    expect(fluid.getParamOverrides(file)).toEqual({ depth: 650 });
  });

  it('exports the active row from the live scene, tweaks included', async () => {
    await renderTweakedCompact();
    const live = manager.currentScene!;
    const runs = host.moduleRuns;
    const res = await post(`${app.url}/api/export`, { format: 'step', shapeIds: [`s${live.no}`], configuration: 'Compact' });
    expect(res.status).toBe(200);
    expect(manager.exported).toEqual([{ scene: live.no, shapeIds: [`s${live.no}`] }]);
    expect(host.moduleRuns).toBe(runs);
    expect(manager.disposed).toEqual([]);
  });

  it('refuses an unknown row with a 400 listing the declared names', async () => {
    await renderTweakedCompact();
    const res = await post(`${app.url}/api/export`, { format: 'step', shapeIds: ['s1'], configuration: 'Huge' });
    expect(res.status).toBe(400);
    expect(res.body.names).toEqual(['Compact', 'Wide']);
    expect(res.body.error).toMatch(/Unknown configuration 'Huge'/);
    expect(manager.exported).toEqual([]);
  });

  it('refuses a configuration that is not a non-empty string', async () => {
    await renderTweakedCompact();
    const res = await post(`${app.url}/api/export`, { format: 'step', shapeIds: ['s1'], configuration: 3 });
    expect(res.status).toBe(400);
  });

  it('exports an assembly of another row at its statement poses', async () => {
    await renderTweakedCompact();
    const res = await post(`${app.url}/api/export`, {
      format: 'step',
      assembly: { poses: [{ instanceId: 'i1', position: { x: 0, y: 0, z: 0 }, quaternion: { x: 0, y: 0, z: 0, w: 1 } }] },
      configuration: 'Wide',
    });
    expect(res.status).toBe(200);
    expect(manager.assemblies).toHaveLength(1);
    expect(manager.assemblies[0].livePoses).toBeUndefined();
    expect(res.headers.get('x-fluidcad-assembly-poses')).toBe('statement');
    expect(manager.disposed).toEqual([manager.assemblies[0].scene]);
  });
});

describe('POST /api/screenshot with a configuration', () => {
  let app: { url: string; close: () => Promise<void> };
  let broadcasts: { active: string | undefined; width: unknown }[];
  let captures: string[];
  let captureFails: boolean;
  let applied: number;

  beforeEach(async () => {
    broadcasts = [];
    captures = [];
    captureFails = false;
    applied = 0;
    const requestScreenshot = async () => {
      captures.push(fluid.getActiveConfiguration(file));
      if (captureFails) {
        throw new Error('No UI client connected');
      }
      return Buffer.from('png');
    };
    const hook = createConfigurationScreenshot(
      fluid,
      (data) => broadcasts.push({ active: data.configurations?.active, width: data.params?.find(p => p.label === 'width')?.currentValue }),
      async () => { applied++; },
    );
    app = await listen(createScreenshotRouter(requestScreenshot, undefined, undefined, hook));
  });

  afterEach(async () => {
    await app.close();
  });

  it('captures with the row on screen, then restores the row and the overrides', async () => {
    await renderTweakedCompact();
    const res = await post(`${app.url}/api/screenshot`, { configuration: 'Wide' });
    expect(res.status).toBe(200);
    expect(captures).toEqual(['Wide']);
    expect(applied).toBe(1);
    expect(broadcasts).toEqual([{ active: 'Wide', width: 1200 }, { active: 'Compact', width: 500 }]);
    expect(fluid.getActiveConfiguration(file)).toBe('Compact');
    expect(fluid.getParamOverrides(file)).toEqual({ depth: 650 });
    expect(host.runs.at(-1)).toEqual({ width: 500, depth: 650 });
  });

  it('restores the row and the overrides when the capture throws', async () => {
    await renderTweakedCompact();
    captureFails = true;
    const res = await post(`${app.url}/api/screenshot`, { configuration: 'Wide' });
    expect(res.status).toBe(503);
    expect(captures).toEqual(['Wide']);
    expect(fluid.getActiveConfiguration(file)).toBe('Compact');
    expect(fluid.getParamOverrides(file)).toEqual({ depth: 650 });
    expect(broadcasts.at(-1)).toEqual({ active: 'Compact', width: 500 });
  });

  it('captures the row already on screen as is', async () => {
    await renderTweakedCompact();
    const res = await post(`${app.url}/api/screenshot`, { configuration: 'Compact' });
    expect(res.status).toBe(200);
    expect(broadcasts).toEqual([]);
    expect(fluid.getParamOverrides(file)).toEqual({ depth: 650 });
  });

  it('refuses an unknown row with a 400 listing the declared names, switching nothing', async () => {
    await renderTweakedCompact();
    const res = await post(`${app.url}/api/screenshot`, { configuration: 'Huge' });
    expect(res.status).toBe(400);
    expect(res.body.names).toEqual(['Compact', 'Wide']);
    expect(captures).toEqual([]);
    expect(broadcasts).toEqual([]);
  });

  it('refuses the option on a server without the hook', async () => {
    const bare = await listen(createScreenshotRouter(async () => Buffer.from('png')));
    try {
      const res = await post(`${bare.url}/api/screenshot`, { configuration: 'Wide' });
      expect(res.status).toBe(400);
    } finally {
      await bare.close();
    }
  });
});

describe('scene summary configurations', () => {
  let app: { url: string; close: () => Promise<void> } | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  const summaryWith = async (table: { active: string; names: string[]; rows: Record<string, any>; modified: boolean }) => {
    const fake = {
      getSceneSummary: () => ({ schemaVersion: 1, file: '/ws/m.fluid.js', objects: [] }),
      getConfigurations: () => table,
    };
    app = await listen(createSceneRouter(fake as any));
    return (await fetch(`${app.url}/api/scene/summary`)).json() as Promise<any>;
  };

  it('lists the table and the row on screen when the file has one', async () => {
    const body = await summaryWith({ active: 'Wide', names: ['Compact', 'Wide'], rows: { Compact: { width: 500 }, Wide: { width: 1200 } }, modified: true });
    expect(body.configurations).toEqual({
      active: 'Wide',
      names: ['Compact', 'Wide'],
      rows: { Compact: { width: 500 }, Wide: { width: 1200 } },
      modified: true,
    });
  });

  it('leaves the field out for a file without a table', async () => {
    const body = await summaryWith({ active: 'Default', names: [], rows: {}, modified: false });
    expect(body).not.toHaveProperty('configurations');
  });
});

describe('package manifest configurations', () => {
  const manifestOf = async (zip: Buffer) => JSON.parse(await (await JSZip.loadAsync(zip)).file('manifest.json')!.async('string'));

  it('packModel records the table and the opening row only when the model declares one', async () => {
    writeFileSync(join(ws, 'model.fluid.js'), SOURCE);
    const withTable = await packModel({
      entryPath: file,
      workspacePath: ws,
      fluidcadVersion: '0.0.0',
      configuration: 'Wide',
      configurations: { names: ['Compact', 'Wide'], rows: { Compact: { width: 500 }, Wide: { width: 1200 } } },
    });
    expect(withTable.manifest.configuration).toBe('Wide');
    expect(withTable.manifest.configurations).toEqual({ names: ['Compact', 'Wide'], rows: { Compact: { width: 500 }, Wide: { width: 1200 } } });

    const without = await packModel({ entryPath: file, workspacePath: ws, fluidcadVersion: '0.0.0', configurations: { names: [], rows: {} } });
    expect(without.manifest).not.toHaveProperty('configuration');
    expect(without.manifest).not.toHaveProperty('configurations');
  });

  describe('POST /api/pack', () => {
    let app: { url: string; close: () => Promise<void> };

    beforeEach(async () => {
      writeFileSync(join(ws, 'model.fluid.js'), SOURCE);
      app = await listen(createPackRouter(fluid, ws, '0.0.0', () => null));
    });

    afterEach(async () => {
      await app.close();
    });

    const pack = async (body: unknown) => {
      const res = await fetch(`${app.url}/api/pack`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { status: res.status, buffer: Buffer.from(await res.arrayBuffer()) };
    };

    it('records the active row, its tweaks and the table', async () => {
      await renderTweakedCompact();
      const res = await pack({});
      expect(res.status).toBe(200);
      const manifest = await manifestOf(res.buffer);
      expect(manifest.configuration).toBe('Compact');
      expect(manifest.configurations).toEqual({ names: ['Compact', 'Wide'], rows: { Compact: { width: 500 }, Wide: { width: 1200 } } });
      expect(manifest.params).toEqual({ depth: 650 });
    });

    it('records a requested row without the active row\'s tweaks', async () => {
      await renderTweakedCompact();
      const manifest = await manifestOf((await pack({ configuration: 'Wide' })).buffer);
      expect(manifest.configuration).toBe('Wide');
      expect(manifest).not.toHaveProperty('params');
      expect(fluid.getActiveConfiguration(file)).toBe('Compact');
    });

    it('refuses an unknown row', async () => {
      await renderTweakedCompact();
      const res = await pack({ configuration: 'Huge' });
      expect(res.status).toBe(400);
      expect(JSON.parse(res.buffer.toString()).names).toEqual(['Compact', 'Wide']);
    });
  });
});
