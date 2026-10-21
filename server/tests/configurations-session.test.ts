import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, realpathSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { FluidCadServer } from '../src/fluidcad-server/index.ts';
import type { SceneHost } from '../src/host/scene-host.ts';
import { createManager, getSceneManager } from '../../lib/dist/scene-manager.js';
import param from '../../lib/dist/core/param.js';
import part from '../../lib/dist/core/part.js';
import configurations from '../../lib/dist/core/configurations.js';
import { normalizePath } from '../src/normalize-path.ts';

// The active configuration is session state beside the param overrides
// (docs/assembly-configurations-plan.md §3.3): installed on the registry
// before every render, reported on the payload, remembered per file in the
// workspace's editor state, and falling back to Default when the file no
// longer declares the row.

/**
 * Stands in for the Vite host, as in param-overrides.test.ts: "running" the
 * module is one part body that declares the table this test holds (`rows`,
 * null for a file without one) and then every `param("label", <number>)`
 * in the buffer.
 */
class FakeHost implements SceneHost {
  buffers = new Map<string, string>();
  moduleRuns = 0;
  rows: Record<string, Record<string, number>> | null = { Compact: { width: 500, depth: 600 }, Wide: { width: 1200 } };

  async init(): Promise<void> {}

  async loadModule(filePath: string): Promise<Record<string, any>> {
    this.moduleRuns++;
    const code = this.buffers.get(filePath) ?? '';
    const scene = (getSceneManager() ?? createManager('')).startScene();
    part('Model', () => {
      if (this.rows) {
        configurations(this.rows);
      }
      for (const m of code.matchAll(/param\("([^"]+)",\s*([\d.]+)\)/g)) {
        param(m[1], Number(m[2]));
      }
    });
    scene.materializeLeftoverDefinitions();
    return {};
  }

  setBuffer(id: string, code: string): void {
    this.buffers.set(id, code);
  }

  getBuffer(fileName: string): string | null {
    return this.buffers.get(fileName) ?? null;
  }

  invalidateModule(): void {}
}

const fakeSceneManager = () => ({
  startScene: () => ({ getRenderedObjects: () => [], getAllSceneObjects: () => [] }),
  setCurrentFile: () => {},
  renderScene: () => {},
  compare: (_prev: any, next: any) => next,
  getAssemblyData: () => null,
});

const SOURCE = 'const width = param("width", 700)\nconst height = param("height", 50)\nconst depth = param("depth", 800)';

let ws: string;
let file: string;
let host: FakeHost;
let server: FluidCadServer;

/** A server over a workspace on disk (no engine: `init` records the missing init.js and the fake manager stands in). */
async function makeServer(): Promise<FluidCadServer> {
  const s = new FluidCadServer(host);
  await s.init(ws);
  s.setSceneManager(fakeSceneManager() as any);
  return s;
}

const render = (code = SOURCE) => server.updateLiveCode(file, code);

const paramOf = (data: Awaited<ReturnType<typeof render>>, label: string) =>
  data?.params?.find((p) => p.label === label);

beforeEach(async () => {
  ws = normalizePath(realpathSync(mkdtempSync(join(tmpdir(), 'fluidcad-configurations-'))));
  file = `${ws}/model.fluid.js`;
  host = new FakeHost();
  server = await makeServer();
});

afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
});

describe('active configuration per session', () => {
  it('reports the table on the render, Default active, no configured values', async () => {
    const data = await render();
    expect(data?.configurations).toEqual({
      active: 'Default',
      names: ['Compact', 'Wide'],
      rows: { Compact: { width: 500, depth: 600 }, Wide: { width: 1200 } },
      modified: false,
    });
    expect(paramOf(data, 'width')).toMatchObject({ currentValue: 700 });
    expect(paramOf(data, 'width')?.configuredValue).toBeUndefined();
    expect(server.getActiveConfiguration(file)).toBe('Default');
  });

  it('answers no rows and Default before any render', () => {
    expect(server.getConfigurations(file)).toEqual({ active: 'Default', names: [], rows: {}, modified: false });
  });

  it('renders the selected row: its cells are the values, the others keep their literals', async () => {
    await render();
    server.selectConfiguration(file, 'Wide');
    const data = await server.recomputeCurrentFile();
    expect(data?.configurations).toMatchObject({ active: 'Wide', modified: false });
    expect(paramOf(data, 'width')).toMatchObject({ currentValue: 1200, configuredValue: 1200 });
    expect(paramOf(data, 'depth')).toMatchObject({ currentValue: 800 });
    expect(paramOf(data, 'depth')?.configuredValue).toBeUndefined();
    expect(server.getActiveConfiguration(file)).toBe('Wide');
    expect(server.getConfigurations(file)).toMatchObject({ active: 'Wide', names: ['Compact', 'Wide'] });
  });

  it('layers a session override on the row and flags the session modified; reset goes back to the row', async () => {
    await render();
    server.selectConfiguration(file, 'Wide');
    await server.recomputeCurrentFile();
    server.setParam(file, 'width', 1300);
    let data = await server.recomputeCurrentFile();
    expect(paramOf(data, 'width')).toMatchObject({ currentValue: 1300, configuredValue: 1200 });
    expect(data?.configurations).toMatchObject({ active: 'Wide', modified: true });
    expect(server.getConfigurations(file).modified).toBe(true);

    server.resetParams(file);
    data = await server.recomputeCurrentFile();
    expect(paramOf(data, 'width')).toMatchObject({ currentValue: 1200, configuredValue: 1200 });
    expect(data?.configurations).toMatchObject({ active: 'Wide', modified: false });
  });

  it('selecting a row drops the session overrides, and Default is the literals again', async () => {
    await render();
    server.setParam(file, 'width', 650);
    await server.recomputeCurrentFile();
    server.selectConfiguration(file, 'Compact');
    expect(server.getParamOverrides(file)).toEqual({});
    let data = await server.recomputeCurrentFile();
    expect(paramOf(data, 'width')).toMatchObject({ currentValue: 500, configuredValue: 500 });
    expect(paramOf(data, 'depth')).toMatchObject({ currentValue: 600, configuredValue: 600 });

    server.selectConfiguration(file, 'Default');
    data = await server.recomputeCurrentFile();
    expect(data?.configurations).toMatchObject({ active: 'Default', modified: false });
    expect(paramOf(data, 'width')).toMatchObject({ currentValue: 700 });
    expect(paramOf(data, 'width')?.configuredValue).toBeUndefined();
  });

  it('switching rows is a different render of the same code — never served from the dedup cache', async () => {
    await render();
    const runs = host.moduleRuns;
    await render();
    expect(host.moduleRuns).toBe(runs);
    server.selectConfiguration(file, 'Wide');
    const data = await render();
    expect(host.moduleRuns).toBe(runs + 1);
    expect(paramOf(data, 'width')).toMatchObject({ currentValue: 1200 });
  });

  it('falls back to Default with a notice when the file no longer declares the row', async () => {
    await render();
    server.selectConfiguration(file, 'Wide');
    await server.recomputeCurrentFile();

    host.rows = { Compact: { width: 500 } };
    const data = await render(SOURCE + '\n// edited');
    expect(data?.configurations).toMatchObject({ active: 'Default', names: ['Compact'] });
    expect(data?.configurations?.notice).toContain("'Wide'");
    expect(paramOf(data, 'width')).toMatchObject({ currentValue: 700 });
    expect(server.getActiveConfiguration(file)).toBe('Default');
    expect(server.getConfigurations(file)).toMatchObject({ active: 'Default', names: ['Compact'] });
  });

  it('a file without a table reports no names, and a selected name is dropped on its render', async () => {
    host.rows = null;
    server.selectConfiguration(file, 'Wide');
    const data = await render();
    expect(data?.configurations).toMatchObject({ active: 'Default', names: [], rows: {} });
    expect(data?.configurations?.notice).toBeDefined();
    expect(server.getActiveConfiguration(file)).toBe('Default');
  });

  it('remembers the row per file in .fluidcad/editor-state.json, keeping the file\'s other fields', async () => {
    mkdirSync(join(ws, '.fluidcad'), { recursive: true });
    writeFileSync(join(ws, '.fluidcad', 'editor-state.json'), JSON.stringify({ openTabs: ['model.fluid.js'], activeTab: 'model.fluid.js' }));
    await render();
    server.selectConfiguration(file, 'Wide');
    expect(JSON.parse(readFileSync(join(ws, '.fluidcad', 'editor-state.json'), 'utf8'))).toEqual({
      openTabs: ['model.fluid.js'],
      activeTab: 'model.fluid.js',
      configurations: { 'model.fluid.js': 'Wide' },
    });

    // A new server over the same workspace renders what was left.
    const reopened = await makeServer();
    const data = await reopened.updateLiveCode(file, SOURCE);
    expect(data?.configurations).toMatchObject({ active: 'Wide' });
    expect(data?.params?.find((p) => p.label === 'width')).toMatchObject({ currentValue: 1200, configuredValue: 1200 });

    // Back on Default the entry goes; the tabs stay.
    reopened.selectConfiguration(file, 'Default');
    expect(JSON.parse(readFileSync(join(ws, '.fluidcad', 'editor-state.json'), 'utf8'))).toEqual({
      openTabs: ['model.fluid.js'],
      activeTab: 'model.fluid.js',
    });
  });

  it('a remembered row the file no longer declares is forgotten on the first render', async () => {
    mkdirSync(join(ws, '.fluidcad'), { recursive: true });
    writeFileSync(join(ws, '.fluidcad', 'editor-state.json'), JSON.stringify({ openTabs: [], activeTab: null, configurations: { 'model.fluid.js': 'Gone' } }));
    const data = await render();
    expect(data?.configurations).toMatchObject({ active: 'Default' });
    expect(data?.configurations?.notice).toContain("'Gone'");
    expect(JSON.parse(readFileSync(join(ws, '.fluidcad', 'editor-state.json'), 'utf8'))).toEqual({ openTabs: [], activeTab: null });
  });

  it('destroying a session forgets its configuration', async () => {
    await render();
    server.selectConfiguration(file, 'Wide');
    server.destroySession(file);
    expect(server.getActiveConfiguration(file)).toBe('Default');
    expect(server.getConfigurations(file)).toEqual({ active: 'Default', names: [], rows: {}, modified: false });
  });
});
