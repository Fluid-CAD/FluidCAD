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
 * Each entry is the scene's rendered list, or `{ rendered, assembly }` to
 * also pre-bake what getAssemblyData reports for that scene.
 */
function fakeManager(sceneContents: Array<any[] | { rendered: any[]; assembly?: any }>) {
  const disposed: any[] = [];
  let next = 0;
  const manager: ScanSceneManager & { disposed: any[]; currentScene?: any; currentFile?: string } = {
    disposed,
    currentScene: { marker: 'live-scene' },
    currentFile: '/ws/live.fluid.js',
    startScene() {
      const entry = sceneContents[next++] ?? [];
      const rendered = Array.isArray(entry) ? entry : entry.rendered;
      const assembly = Array.isArray(entry) ? undefined : entry.assembly;
      return { getRenderedObjects: () => rendered, assembly };
    },
    startAssemblyScene() {
      return this.startScene();
    },
    getAssemblyData(scene: any) {
      return scene.assembly ?? { instances: [], mates: [] };
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
    expect(result.errors[0].message).toContain('Default exports are not insertable');
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

  it('classifies an assembly-file factory that inserted instances as a sub-assembly', async () => {
    const instances = [
      { instanceId: 'inst-0', partId: 'pA', partName: 'A', position: { x: 0, y: 0, z: 0 } },
      { instanceId: 'inst-1', partId: 'pA', partName: 'A', position: { x: 10, y: 0, z: 0 } },
      { instanceId: 'inst-2', partId: 'pB', partName: 'B', position: { x: 0, y: 5, z: 0 } },
    ];
    const mates = [{ mateId: 'm0', type: 'fastened' }];
    const factoryRendered = [
      rendered('pA'), rendered('a-child', 'pA'),
      rendered('pB'),
    ];
    const result = await scanFileForParts(
      fakeHost({ frameAssembly: () => ({ left: 'instance-map' }) }),
      fakeManager([[], { rendered: factoryRendered, assembly: { instances, mates } }]),
      '/ws/frame.assembly.js',
    );
    expect(result.errors).toEqual([]);
    expect(result.parts).toEqual([]);
    expect(result.assemblies).toHaveLength(1);
    const sub = result.assemblies[0];
    expect(sub).toMatchObject({ exportName: 'frameAssembly', kind: 'assembly' });
    expect(sub.instances).toHaveLength(3);
    expect(sub.mates).toHaveLength(1);
    // One template subtree per DISTINCT part, in first-reference order.
    expect(sub.objects.map((o: any) => o.id)).toEqual(['pA', 'a-child', 'pB']);
  });

  it('runs a lazy assembly() definition returned by a factory (exportKind factory)', async () => {
    const instances = [{ instanceId: 'inst-0', partId: 'pA', partName: 'A' }];
    let ran = 0;
    const definition = {
      assemblyName: 'x-axis',
      getType: () => 'assembly',
      run: () => { ran++; },
    };
    const result = await scanFileForParts(
      fakeHost({ xAxis: () => definition }),
      fakeManager([[], { rendered: [rendered('pA')], assembly: { instances, mates: [] } }]),
      '/ws/x-axis.assembly.js',
    );
    expect(ran).toBe(1);
    expect(result.errors).toEqual([]);
    expect(result.assemblies).toHaveLength(1);
    expect(result.assemblies[0]).toMatchObject({
      exportName: 'xAxis',
      kind: 'assembly',
      exportKind: 'factory',
      assemblyName: 'x-axis',
    });
  });

  it('runs a directly exported assembly() definition (exportKind value)', async () => {
    const instances = [{ instanceId: 'inst-0', partId: 'pA', partName: 'A' }];
    let ran = 0;
    const definition = {
      assemblyName: 'gantry',
      getType: () => 'assembly',
      run: () => { ran++; },
    };
    const result = await scanFileForParts(
      fakeHost({ gantry: definition }),
      fakeManager([[], { rendered: [rendered('pA')], assembly: { instances, mates: [] } }]),
      '/ws/gantry.assembly.js',
    );
    expect(ran).toBe(1);
    expect(result.errors).toEqual([]);
    expect(result.assemblies).toHaveLength(1);
    expect(result.assemblies[0]).toMatchObject({
      exportName: 'gantry',
      kind: 'assembly',
      exportKind: 'value',
      assemblyName: 'gantry',
    });
  });

  it('reports a definition whose body throws as an error', async () => {
    const definition = {
      assemblyName: 'bad',
      getType: () => 'assembly',
      run: () => { throw new Error('body exploded'); },
    };
    const result = await scanFileForParts(
      fakeHost({ bad: definition }),
      fakeManager([[], []]),
      '/ws/bad.assembly.js',
    );
    expect(result.assemblies).toEqual([]);
    expect(result.errors).toEqual([{ exportName: 'bad', message: 'body exploded' }]);
  });

  it('finds sub-assembly part templates built at module level', async () => {
    const instances = [{ instanceId: 'inst-0', partId: 'shared', partName: 'S' }];
    const result = await scanFileForParts(
      fakeHost({ sub: () => undefined }),
      fakeManager([
        { rendered: [rendered('shared')] },
        { rendered: [], assembly: { instances, mates: [] } },
      ]),
      '/ws/sub.assembly.js',
    );
    expect(result.assemblies).toHaveLength(1);
    expect(result.assemblies[0].objects.map((o: any) => o.id)).toEqual(['shared']);
  });

  it('still records plain part exports from assembly files', async () => {
    const p = fakePart('p1', 'Inline Part');
    const result = await scanFileForParts(
      fakeHost({ inlinePart: p, helper: () => 42 }),
      fakeManager([{ rendered: [rendered('p1')] }, { rendered: [] }]),
      '/ws/lib.assembly.js',
    );
    expect(result.parts).toHaveLength(1);
    expect(result.parts[0]).toMatchObject({ exportName: 'inlinePart', kind: 'value' });
    expect(result.assemblies).toEqual([]);
  });

  it('does not classify factories in part-kind files as sub-assemblies', async () => {
    // In a part-kind file the factory scene is a part scene — getAssemblyData
    // is never consulted, so a factory returning a non-part stays skipped.
    const result = await scanFileForParts(
      fakeHost({ helper: () => ({ some: 'map' }) }),
      fakeManager([[], { rendered: [], assembly: { instances: [{ instanceId: 'x', partId: 'p' }], mates: [] } }]),
      '/ws/helpers.fluid.js',
    );
    expect(result.assemblies).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('refuses assembly files on engines without assembly support', async () => {
    const manager = fakeManager([[]]);
    delete (manager as any).startAssemblyScene;
    const result = await scanFileForParts(fakeHost({}), manager, '/ws/frame.assembly.js');
    expect(result.errors[0].message).toContain('predates assembly scanning');
  });

  it('refuses a host without raw module loading', async () => {
    const host = fakeHost({});
    delete (host as any).loadModuleRaw;
    const result = await scanFileForParts(host, fakeManager([[]]), '/ws/x.fluid.js');
    expect(result.errors[0].message).toContain('does not support part scanning');
  });
});
