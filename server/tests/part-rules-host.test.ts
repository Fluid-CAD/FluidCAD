import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LocalSceneHost } from '../src/host/local-scene-host.ts';
import type { LoadModuleOptions, SceneHost } from '../src/host/scene-host.ts';
import { FluidCadServer } from '../src/fluidcad-server/index.ts';
import { createManager, getSceneManager } from '../../lib/dist/scene-manager.js';
import { createParamRegistry, PartRules } from '../../lib/dist/index.js';
import param from '../../lib/dist/core/param.js';
import part from '../../lib/dist/core/part.js';

// The export rule at render (lib PartRules — every part is exported): the
// Vite host resolves every export of the entry module (a factory called for
// the definition it returns) and hands them to the render BEFORE any export
// builds, so the scene refuses the parts the module does not export; the
// server wires that hook into its live and scratch renders.

const FILE = '/ws/pair.part.js';

/** The host's own `loadModule`, with Vite's module runner answering `load()`. */
function hostReturning(load: () => Record<string, unknown>): LocalSceneHost {
  const host = new LocalSceneHost();
  (host as unknown as { runner: { import: () => Promise<Record<string, unknown>> } }).runner = {
    import: async () => load(),
  };
  return host;
}

/** Evaluate `code` as the top level of `FILE`: part() calls carry its call sites. Returns the code's exports object. */
function evaluate(code: string): Record<string, unknown> {
  return new Function('part', 'param', `"use strict";\n${code}\n//# sourceURL=${FILE}`)(part, param) as Record<string, unknown>;
}

describe('LocalSceneHost.loadModule — the export hook', () => {
  beforeEach(() => {
    createParamRegistry();
  });

  it('resolves every export before any builds, and the scene refuses what the module does not export', async () => {
    const scene = (getSceneManager() ?? createManager('')).startScene();
    const built: string[] = [];
    const seen: [string, unknown][][] = [];
    const host = hostReturning(() => evaluate(`
      const plate = part('Plate', () => { param('Width', 40); });
      part('Loose', () => { param('Width', 10); });
      const bolt = () => part('Bolt', () => { param('Length', 8); });
      return { plate, bolt };
    `));
    const options: LoadModuleOptions = {
      onExports: (exports) => {
        seen.push(exports);
        built.push(...scene.getAllSceneObjects().map((o: { getType(): string }) => o.getType()));
        scene.refuseUnexportedParts(exports, FILE);
      },
    };
    await host.loadModule(FILE, options);
    scene.materializeLeftoverDefinitions();

    // The factory was called for its definition; nothing had built yet.
    expect(seen).toHaveLength(1);
    expect(seen[0].map(([name, value]) => [name, (value as { partName?: string }).partName])).toEqual([['plate', 'Plate'], ['bolt', 'Bolt']]);
    expect(built).toEqual([]);
    const parts = scene.getAllSceneObjects().filter((o: { getType(): string }) => o.getType() === 'part');
    expect(parts.map((p: { partName: string; getRefusal(): string | null }) => [p.partName, p.getRefusal()])).toEqual([
      ['Plate', null],
      ['Bolt', null],
      ['Loose', PartRules.unexportedMessage('Loose')],
    ]);
  });

  it('does not call the hook when evaluation stopped', async () => {
    const onExports = vi.fn();
    const host = hostReturning(() => {
      throw new Error('stopped');
    });
    await expect(host.loadModule(FILE, { onExports })).rejects.toThrow('stopped');
    expect(onExports).not.toHaveBeenCalled();
  });
});

describe('FluidCadServer — entry renders refuse unexported parts', () => {
  it('hands the module exports to the scene with the file', async () => {
    const refuse = vi.fn();
    const scene = { getRenderedObjects: () => [], getAllSceneObjects: () => [], refuseUnexportedParts: refuse };
    const host: SceneHost = {
      async init() {},
      async loadModule(_filePath: string, options?: LoadModuleOptions) {
        options?.onExports?.([['plate', 'definition']]);
        return {};
      },
      setBuffer() {},
      getBuffer: () => null,
      invalidateModule() {},
    };
    const server = new FluidCadServer(host);
    server.setSceneManager({
      startScene: () => scene,
      setCurrentFile: () => {},
      renderScene: () => {},
      compare: (_prev: unknown, next: unknown) => next,
      getAssemblyData: () => null,
    } as any);
    await server.updateLiveCode(FILE, '');
    expect(refuse).toHaveBeenCalledWith([['plate', 'definition']], FILE);
  });
});
