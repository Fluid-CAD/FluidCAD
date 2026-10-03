import { describe, it, expect, beforeEach } from 'vitest';
import { FluidCadServer } from '../src/fluidcad-server/index.ts';
import type { SceneHost } from '../src/host/scene-host.ts';

// A dialog's preview and its Apply synthesize the same picks with the same
// options against the same rendered scene. On a large part each synthesis is
// a filter search over the whole model, so the server answers the second from
// the first — and must never answer across a re-render, a different request
// or different file-coupled options.

const FILE = '/ws/plate.part.js';
const PICK = { shapeId: 'shape-1', sub: { type: 'edge' as const, index: 4 } };

class FakeHost implements SceneHost {
  buffers = new Map<string, string>();

  async init(): Promise<void> {}

  async loadModule(): Promise<Record<string, any>> {
    return {};
  }

  setBuffer(id: string, code: string): void {
    this.buffers.set(id, code);
  }

  getBuffer(fileName: string): string | null {
    return this.buffers.get(`virtual:live-render:${fileName}`) ?? null;
  }

  invalidateModule(): void {}

  getModuleDependencies(filePath: string): string[] {
    return [filePath.replace('virtual:live-render:', '')];
  }
}

/** Every synthesis the kernel ran, with the scene it ran against. */
let synthesized: { scene: unknown; value: unknown; options: any }[];
let server: FluidCadServer;

beforeEach(() => {
  synthesized = [];
  server = new FluidCadServer(new FakeHost());
  server.setSceneManager({
    startScene: () => ({ getRenderedObjects: () => [], getAllSceneObjects: () => [] }),
    setCurrentFile: () => {},
    renderScene: () => {},
    compare: (_prev: any, next: any) => next,
    getAssemblyData: () => null,
    synthesizeApplyFeature: (scene: unknown, _refs: unknown, _feature: unknown, value: unknown, _chains: unknown, options: any) => {
      synthesized.push({ scene, value, options });
      return { ok: true, args: `select(edge()).center()`, spec: { feature: 'connector' } };
    },
  } as any);
});

const connector = (anchor: string) => ({ connector: { anchor: { kind: anchor } } });

describe('synthesizeApplyFeatureCached', () => {
  it('answers a repeated request from the scene it already ran against', async () => {
    await server.updateLiveCode(FILE, 'v1');
    const first = server.synthesizeApplyFeatureCached('key-a', [PICK], 'connector', 'c1', [], connector('center'));
    const second = server.synthesizeApplyFeatureCached('key-a', [PICK], 'connector', 'c1', [], connector('center'));
    expect(second).toBe(first);
    expect(synthesized).toHaveLength(1);
  });

  it('runs again for a different request or different file-coupled options', async () => {
    await server.updateLiveCode(FILE, 'v1');
    server.synthesizeApplyFeatureCached('key-a', [PICK], 'connector', 'c1', [], connector('center'));
    server.synthesizeApplyFeatureCached('key-a', [PICK], 'connector', 'c2', [], connector('center'));
    server.synthesizeApplyFeatureCached('key-a', [PICK], 'connector', 'c1', [], connector('start'));
    server.synthesizeApplyFeatureCached('key-b', [PICK], 'connector', 'c1', [], connector('center'));
    expect(synthesized).toHaveLength(4);
  });

  it('never answers across a re-render', async () => {
    await server.updateLiveCode(FILE, 'v1');
    server.synthesizeApplyFeatureCached('key-a', [PICK], 'connector', 'c1', [], connector('center'));
    await server.updateLiveCode(FILE, 'v2');
    server.synthesizeApplyFeatureCached('key-a', [PICK], 'connector', 'c1', [], connector('center'));
    expect(synthesized).toHaveLength(2);
    expect(synthesized[1].scene).not.toBe(synthesized[0].scene);
  });

  it('skips the memo without an options key', async () => {
    await server.updateLiveCode(FILE, 'v1');
    server.synthesizeApplyFeatureCached(null, [PICK], 'connector', 'c1', [], connector('center'));
    server.synthesizeApplyFeatureCached(null, [PICK], 'connector', 'c1', [], connector('center'));
    expect(synthesized).toHaveLength(2);
  });
});
