// A scanned part that imports a `*.params.js` file never lists the project
// parameters as its own interface: the scan's throwaway registry holds the
// globals the import registered (`kind: 'global'`), and `collectedParams`
// leaves them out (`docs/global-parameters-plan.md` §2.6).

import { describe, it, expect } from 'vitest';
import { scanFileForParts, type ScanSceneManager } from '../src/part-catalog/scan.ts';
import type { SceneHost } from '../src/host/scene-host.ts';
import { getParamRegistry } from '../../lib/dist/index.js';

function fakePart(id: string, partName: string) {
  return { id, partName, getType: () => 'part' };
}

function rendered(id: string, parentId: string | null = null) {
  return { id, parentId, sceneShapes: [], type: 'x' };
}

function fakeManager(sceneContents: any[][]) {
  let next = 0;
  const manager: ScanSceneManager & { currentScene?: any; currentFile?: string } = {
    currentScene: { marker: 'live-scene' },
    currentFile: '/ws/live.fluid.js',
    startScene() {
      const entry = sceneContents[next++] ?? [];
      return { getRenderedObjects: () => entry };
    },
    startAssemblyScene() {
      return this.startScene();
    },
    getAssemblyData() {
      return { instances: [], mates: [] };
    },
    renderScene() {},
    setCurrentFile(filePath: string) {
      this.currentFile = filePath;
    },
    disposeScene() {},
  };
  return manager;
}

function fakeHost(mod: Record<string, any>): SceneHost {
  return {
    async init() {},
    async loadModule() { return mod; },
    setBuffer() {},
    getBuffer() { return null; },
    invalidateModule() {},
    async loadModuleRaw() { return mod; },
    getModuleDependencies() { return []; },
  };
}

/** A lazy definition whose build registers the given definitions in the scan registry. */
function fakeDefinition(part: any, params: any[]) {
  return {
    getType: () => 'part-definition',
    materialize() {
      for (const def of params) {
        getParamRegistry().register(def);
      }
      return part;
    },
  };
}

describe('scanFileForParts — project parameters', () => {
  it('lists the part\'s own params and leaves out the globals a params import registered', async () => {
    const def = fakeDefinition(fakePart('d1', 'Bracket'), [
      { label: 'Length', kind: 'part', defaultValue: 150, currentValue: 150, controlType: 'number' },
      {
        label: 'Wall thickness', kind: 'global', defaultValue: 3, currentValue: 3, controlType: 'number',
        sourceLocation: { filePath: '/ws/project.params.js', line: 3, column: 20 },
      },
    ]);
    const result = await scanFileForParts(
      fakeHost({ bracket: def }),
      fakeManager([[], [rendered('d1')]]),
      '/ws/bracket.part.js',
    );
    expect(result.errors).toEqual([]);
    expect(result.parts).toHaveLength(1);
    expect(result.parts[0].params).toEqual([
      { label: 'Length', defaultValue: 150, currentValue: 150, controlType: 'number' },
    ]);
  });
});
