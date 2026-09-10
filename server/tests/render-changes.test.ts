// The render change summary exists for the MCP's writes and for nothing
// else. A person typing in the editor drives the same `updateLiveCode` /
// `recomputeCurrentFile` calls without the flag, and those must not touch
// the engine's change tracker at all: no tracker created, the compare called
// exactly as before, no `changes` on the data. With the flag, the tracker
// rides the compare (or, on a forced rebuild, captures the stale scene while
// it is still alive) and the summary lands on the outcome.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FluidCadServer } from '../src/fluidcad-server.ts';
import type { SceneHost } from '../src/host/scene-host.ts';

const FILE = '/ws/model.fluid.js';

class FakeHost implements SceneHost {
  buffers = new Map<string, string>();
  moduleRuns = 0;

  async init(): Promise<void> {}

  async loadModule(): Promise<Record<string, any>> {
    this.moduleRuns++;
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

const SUMMARY = { rebuilt: [], added: [], removed: [], reused: 2 };
const UNCHANGED = { rebuilt: [], added: [], removed: [], reused: 3 };

function fakeScene(label: string) {
  return { label, getRenderedObjects: () => [], getAllSceneObjects: () => [] };
}

let sceneCount: number;
let tracker: { captureBefore: ReturnType<typeof vi.fn>; summarize: ReturnType<typeof vi.fn>; summarizeUnchanged: ReturnType<typeof vi.fn> };
let engine: {
  startScene: ReturnType<typeof vi.fn>;
  compare: ReturnType<typeof vi.fn>;
  trackRenderChanges: ReturnType<typeof vi.fn>;
  disposeScene: ReturnType<typeof vi.fn>;
  setCurrentFile: () => void;
  renderScene: () => void;
  getAssemblyData: () => null;
};
let host: FakeHost;
let server: FluidCadServer;

beforeEach(() => {
  sceneCount = 0;
  tracker = {
    captureBefore: vi.fn(),
    summarize: vi.fn(() => SUMMARY),
    summarizeUnchanged: vi.fn(() => UNCHANGED),
  };
  engine = {
    startScene: vi.fn(() => fakeScene(`scene-${++sceneCount}`)),
    compare: vi.fn((_previous: any, next: any) => next),
    trackRenderChanges: vi.fn(() => tracker),
    disposeScene: vi.fn(),
    setCurrentFile: () => {},
    renderScene: () => {},
    getAssemblyData: () => null,
  };
  host = new FakeHost();
  server = new FluidCadServer(host);
  server.setSceneManager(engine as any);
});

describe('render change summary gating', () => {
  it('a render without the flag never creates a tracker and compares exactly as before', async () => {
    const first = await server.updateLiveCode(FILE, 'a');
    const second = await server.updateLiveCode(FILE, 'b');

    expect(engine.trackRenderChanges).not.toHaveBeenCalled();
    expect(engine.compare).toHaveBeenCalledTimes(1);
    expect(engine.compare.mock.calls[0][0].label).toBe('scene-1');
    expect(engine.compare.mock.calls[0][1].label).toBe('scene-2');
    expect(engine.compare.mock.calls[0][2]).toBeUndefined();
    expect(first).not.toHaveProperty('changes');
    expect(second).not.toHaveProperty('changes');
  });

  it('a flagged render hands the tracker to the compare and summarizes the rendered scene', async () => {
    await server.updateLiveCode(FILE, 'a');
    const data = await server.updateLiveCode(FILE, 'b', { changes: true });

    expect(engine.trackRenderChanges).toHaveBeenCalledTimes(1);
    expect(engine.compare).toHaveBeenCalledTimes(1);
    expect(engine.compare.mock.calls[0][2]).toBe(tracker);
    expect(tracker.captureBefore).not.toHaveBeenCalled();
    expect(tracker.summarize).toHaveBeenCalledTimes(1);
    expect(tracker.summarize.mock.calls[0][0].label).toBe('scene-2');
    expect(data?.changes).toBe(SUMMARY);
  });

  it('a first render with the flag summarizes without a compare', async () => {
    const data = await server.updateLiveCode(FILE, 'a', { changes: true });

    expect(engine.compare).not.toHaveBeenCalled();
    expect(tracker.summarize).toHaveBeenCalledTimes(1);
    expect(data?.changes).toBe(SUMMARY);
  });

  it('a deduplicated flagged render reports nothing built, without touching the cached data', async () => {
    await server.updateLiveCode(FILE, 'a', { changes: true });
    const runs = host.moduleRuns;

    const deduped = await server.updateLiveCode(FILE, 'a', { changes: true });
    expect(host.moduleRuns).toBe(runs);
    expect(tracker.summarizeUnchanged).toHaveBeenCalledTimes(1);
    expect(tracker.summarizeUnchanged.mock.calls[0][0].label).toBe('scene-1');
    expect(deduped?.changes).toBe(UNCHANGED);

    const plain = await server.updateLiveCode(FILE, 'a');
    expect(host.moduleRuns).toBe(runs);
    expect(plain).not.toHaveProperty('changes');
  });

  it('a flagged forced recompute captures the stale scene before disposing it', async () => {
    await server.updateLiveCode(FILE, 'a');
    const order: string[] = [];
    tracker.captureBefore.mockImplementation(() => order.push('capture'));
    engine.disposeScene.mockImplementation(() => order.push('dispose'));

    const data = await server.recomputeCurrentFile(true, { changes: true });

    expect(order).toEqual(['capture', 'dispose']);
    expect(tracker.captureBefore.mock.calls[0][0].label).toBe('scene-1');
    expect(tracker.captureBefore.mock.calls[0][1]).toEqual(new Map());
    expect(engine.compare).not.toHaveBeenCalled();
    expect(tracker.summarize.mock.calls[0][0].label).toBe('scene-2');
    expect(data?.changes).toBe(SUMMARY);
  });

  it('an unflagged forced recompute disposes and rebuilds exactly as before', async () => {
    await server.updateLiveCode(FILE, 'a');

    const data = await server.recomputeCurrentFile(true);

    expect(engine.trackRenderChanges).not.toHaveBeenCalled();
    expect(engine.disposeScene).toHaveBeenCalledTimes(1);
    expect(engine.compare).not.toHaveBeenCalled();
    expect(data).not.toHaveProperty('changes');
  });

  it('degrades to no summary on an engine that predates the tracker', async () => {
    delete (engine as Partial<typeof engine>).trackRenderChanges;
    await server.updateLiveCode(FILE, 'a');

    const data = await server.updateLiveCode(FILE, 'b', { changes: true });

    expect(engine.compare.mock.calls[0][2]).toBeUndefined();
    expect(data).not.toHaveProperty('changes');
  });
});
