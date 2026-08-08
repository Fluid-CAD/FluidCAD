import { describe, it, expect } from 'vitest';
import { scanFileForParts, type ScanSceneManager } from '../src/part-catalog/scan.ts';
import type { SceneHost } from '../src/host/scene-host.ts';
import { getParamRegistry } from '../../lib/dist/index.js';

/** A duck-typed Part the scanner should recognize (never a real class). */
function fakePart(id: string, partName: string) {
  return { id, partName, getType: () => 'part' };
}

function rendered(id: string, parentId: string | null = null) {
  return { id, parentId, sceneShapes: [], type: 'x' };
}

/**
 * A fake manager that hands out pre-baked scenes in startScene() order: the
 * module scene first, then one per exported function the scanner calls.
 */
function fakeManager(sceneContents: any[][]) {
  const disposed: any[] = [];
  let next = 0;
  const manager: ScanSceneManager & { disposed: any[]; currentScene?: any; currentFile?: string } = {
    disposed,
    currentScene: { marker: 'live-scene' },
    currentFile: '/ws/live.fluid.js',
    startScene() {
      const content = sceneContents[next++] ?? [];
      return { getRenderedObjects: () => content };
    },
    renderScene() {},
    setCurrentFile(filePath: string) {
      this.currentFile = filePath;
    },
    disposeScene(scene: any) {
      disposed.push(scene);
    },
  };
  return manager;
}

function fakeHost(mod: Record<string, any>, deps: string[] = []): SceneHost {
  return {
    async init() {},
    async loadModule() { return mod; },
    setBuffer() {},
    getBuffer() { return null; },
    invalidateModule() {},
    async loadModuleRaw() { return mod; },
    getModuleDependencies() { return deps; },
  };
}

describe('scanFileForParts', () => {
  it('records a directly exported part with its subtree from the module scene', async () => {
    const body = fakePart('p1', 'Box Body');
    const moduleScene = [
      rendered('p1'),
      rendered('sketch1', 'p1'),
      rendered('extrude1', 'p1'),
      rendered('unrelated'),
    ];
    const result = await scanFileForParts(
      fakeHost({ boxBody: body }),
      fakeManager([moduleScene]),
      '/ws/box.fluid.js',
    );
    expect(result.errors).toEqual([]);
    expect(result.parts).toHaveLength(1);
    expect(result.parts[0]).toMatchObject({
      exportName: 'boxBody',
      partName: 'Box Body',
      kind: 'value',
      rootId: 'p1',
    });
    expect(result.parts[0].objects.map(o => o.id)).toEqual(['p1', 'sketch1', 'extrude1']);
  });

  it('calls factory exports with zero args and attributes the returned part', async () => {
    const plate = fakePart('sp1', 'Side Plate');
    const factoryScene = [rendered('sp1'), rendered('child', 'sp1')];
    const result = await scanFileForParts(
      fakeHost({ RAIL_WIDTH: 20, sidePlate: () => plate }),
      fakeManager([[], factoryScene]),
      '/ws/side-plate.part.js',
    );
    expect(result.errors).toEqual([]);
    expect(result.parts).toHaveLength(1);
    expect(result.parts[0]).toMatchObject({ exportName: 'sidePlate', kind: 'factory', rootId: 'sp1' });
    expect(result.parts[0].objects.map(o => o.id)).toEqual(['sp1', 'child']);
  });

  it('finds a factory-returned part built at module level (shared state)', async () => {
    const shared = fakePart('shared1', 'Shared');
    const moduleScene = [rendered('shared1')];
    const result = await scanFileForParts(
      fakeHost({ getShared: () => shared }),
      fakeManager([moduleScene, []]),
      '/ws/shared.fluid.js',
    );
    expect(result.parts).toHaveLength(1);
    expect(result.parts[0].rootId).toBe('shared1');
  });

  it('reports a throwing export (assembly factory) as an error, not a part', async () => {
    const good = fakePart('g1', 'Good');
    const result = await scanFileForParts(
      fakeHost({
        frameAssembly: () => { throw new Error('insert() can only be used in *.assembly.js files.'); },
        goodPart: () => good,
      }),
      fakeManager([[], [], [rendered('g1')]]),
      '/ws/frame.assembly.js',
    );
    expect(result.parts).toHaveLength(1);
    expect(result.parts[0].exportName).toBe('goodPart');
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ exportName: 'frameAssembly' });
    expect(result.errors[0].message).toContain('insert()');
  });

  it('skips non-part values and functions returning non-parts silently', async () => {
    const result = await scanFileForParts(
      fakeHost({ WIDTH: 20, helper: () => 42, obj: { some: 'thing' } }),
      fakeManager([[], []]),
      '/ws/helpers.fluid.js',
    );
    expect(result.parts).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('rejects default-exported parts with a readable message', async () => {
    const result = await scanFileForParts(
      fakeHost({ default: fakePart('d1', 'Anon') }),
      fakeManager([[rendered('d1')]]),
      '/ws/anon.fluid.js',
    );
    expect(result.parts).toEqual([]);
    expect(result.errors[0].message).toContain('Default-exported');
  });

  it('reports a module that throws on load as a file-level error', async () => {
    const host = fakeHost({});
    host.loadModuleRaw = async () => { throw new Error('insert() can only be used in *.assembly.js files.'); };
    const result = await scanFileForParts(host, fakeManager([[]]), '/ws/index.assembly.js');
    expect(result.parts).toEqual([]);
    expect(result.errors).toEqual([
      { exportName: null, message: 'insert() can only be used in *.assembly.js files.' },
    ]);
  });

  it('lists dependencies including the scanned file itself', async () => {
    const result = await scanFileForParts(
      fakeHost({ p: fakePart('p1', 'P') }, ['/ws/dep.fluid.js']),
      fakeManager([[rendered('p1')]]),
      '/ws/main.fluid.js',
    );
    expect(result.deps).toContain('/ws/dep.fluid.js');
    expect(result.deps).toContain('/ws/main.fluid.js');
  });

  it('restores the param registry, current file, and current scene', async () => {
    const before = getParamRegistry();
    const manager = fakeManager([[]]);
    const liveScene = manager.currentScene;
    await scanFileForParts(fakeHost({}), manager, '/ws/box.fluid.js');
    expect(getParamRegistry()).toBe(before);
    expect(manager.currentFile).toBe('/ws/live.fluid.js');
    expect(manager.currentScene).toBe(liveScene);
  });

  it('disposes every scene it started', async () => {
    const manager = fakeManager([[], [], []]);
    await scanFileForParts(
      fakeHost({ a: () => fakePart('a1', 'A'), b: () => 1 }),
      manager,
      '/ws/two.fluid.js',
    );
    // Module scene + one per function export.
    expect(manager.disposed).toHaveLength(3);
  });

  it('refuses a host without raw module loading', async () => {
    const host = fakeHost({});
    delete (host as any).loadModuleRaw;
    const result = await scanFileForParts(host, fakeManager([[]]), '/ws/x.fluid.js');
    expect(result.errors[0].message).toContain('does not support part scanning');
  });
});
