import { describe, it, expect, beforeEach } from 'vitest';
import { FluidCadServer } from '../src/fluidcad-server.ts';
import type { SceneHost } from '../src/host/scene-host.ts';

// The per-file render caches (dedup + renderingCache) must not outlive a
// DEPENDENCY's edit: editing a part file and switching back to the assembly
// previously served the assembly's cached render — connectors added to the
// part never appeared in the mate dialog until a manual recompute.

const ASSEMBLY = '/ws/rig.assembly.js';
const PART = '/ws/block.fluid.js';
const OTHER = '/ws/other.fluid.js';

/**
 * Stands in for the Vite host: "running" a module just records which entry
 * ran, and the dependency closure is canned — the assembly imports the part.
 */
class FakeHost implements SceneHost {
  buffers = new Map<string, string>();
  runs: string[] = [];
  deps = new Map<string, string[]>([
    [ASSEMBLY, [ASSEMBLY, PART]],
    [PART, [PART]],
    [OTHER, [OTHER]],
  ]);

  async init(): Promise<void> {}

  async loadModule(filePath: string): Promise<Record<string, any>> {
    this.runs.push(filePath.replace('virtual:live-render:', ''));
    return {};
  }

  setBuffer(id: string, code: string): void {
    this.buffers.set(id, code);
  }

  getBuffer(fileName: string): string | null {
    return this.buffers.get(fileName) ?? null;
  }

  invalidateModule(): void {}

  getModuleDependencies(filePath: string): string[] {
    return this.deps.get(filePath.replace('virtual:live-render:', '')) ?? [];
  }
}

const fakeSceneManager = () => ({
  startScene: () => ({ getRenderedObjects: () => [], getAllSceneObjects: () => [] }),
  startAssemblyScene: () => ({ getRenderedObjects: () => [], getAllSceneObjects: () => [] }),
  setCurrentFile: () => {},
  renderScene: () => {},
  compare: (_prev: any, next: any) => next,
  getAssemblyData: () => null,
});

let host: FakeHost;
let server: FluidCadServer;

beforeEach(() => {
  host = new FakeHost();
  server = new FluidCadServer(host);
  server.setSceneManager(fakeSceneManager() as any);
});

describe('dependency-aware render cache invalidation', () => {
  it('an unchanged file still dedups when nothing it imports changed', async () => {
    await server.updateLiveCode(ASSEMBLY, 'assembly-v1');
    const runs = host.runs.length;
    await server.updateLiveCode(ASSEMBLY, 'assembly-v1');
    expect(host.runs.length).toBe(runs);
  });

  it('editing an imported part re-renders the assembly on switch-back', async () => {
    await server.updateLiveCode(ASSEMBLY, 'assembly-v1');
    // "Open the part, add connectors" — the part session renders.
    await server.updateLiveCode(PART, 'part-with-connectors');

    // "Back to the assembly" — identical assembly code must NOT dedup: the
    // part it imports changed underneath it.
    const runs = host.runs.length;
    await server.updateLiveCode(ASSEMBLY, 'assembly-v1');
    expect(host.runs.length).toBe(runs + 1);
    expect(host.runs[host.runs.length - 1]).toBe(ASSEMBLY);
  });

  it('editing an unrelated file leaves the dedup intact', async () => {
    await server.updateLiveCode(ASSEMBLY, 'assembly-v1');
    await server.updateLiveCode(OTHER, 'other-v1');

    const runs = host.runs.length;
    await server.updateLiveCode(ASSEMBLY, 'assembly-v1');
    expect(host.runs.length).toBe(runs);
  });
});
