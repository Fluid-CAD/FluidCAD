import { describe, expect, it } from 'vitest';
import { FluidCadServer, sceneStopFields } from '../src/fluidcad-server/index.ts';
import type { SceneHost } from '../src/host/scene-host.ts';
import { BreakpointHit } from '../../lib/dist/common/breakpoint-hit.js';

const FILE = '/ws/model.part.js';
const FULL = 'extrude(1);\nfillet(2).name(label);';
const PAUSED = 'extrude(1);\nbreakpoint();\nfillet(2).name(label);';

class Host implements SceneHost {
  readonly buffers = new Map<string, string>();
  rows: any[] = [];
  error: Error | null = null;
  loads = 0;
  duringLoad?: () => void;
  async init() {}
  async loadModule() { this.loads++; this.duringLoad?.(); if (this.error) throw this.error; return {}; }
  invalidateModule() {}
  setBuffer(path: string, code: string) { this.buffers.set(path, code); }
  getBuffer(path: string) { return this.buffers.get(`virtual:live-render:${path}`) ?? null; }
}

function setup() {
  const host = new Host();
  const server = new FluidCadServer(host);
  server.setSceneManager({
    startScene: () => {
      const rows = host.rows;
      return { getRenderedObjects: () => rows, getAllSceneObjects: () => [] };
    },
    setCurrentFile: () => {}, renderScene: () => {},
    compare: (_old: any, next: any) => next,
    getAssemblyData: () => null,
    rollbackScene: (_scene: any, index: number) => ({ stop: index, scopePartId: null }),
  } as any);
  return { server, host };
}

function feature(id: string, line: number, type: string) {
  return { id, type, uniqueType: type, name: `Computed ${id}`, parentId: null,
    sourceLocation: { filePath: FILE, line, column: 1 }, sceneShapes: [{ largeMesh: [1, 2, 3] }] };
}

describe('breakpoint history through server renders', () => {
  it('retains history through repeated pauses, cache hits, rollback and file switches', async () => {
    const { host, server } = setup();
    host.rows = [feature('a', 1, 'extrude'), feature('b', 2, 'fillet')];
    const full = await server.updateLiveCode(FILE, FULL);
    expect(full?.timeline).toBeUndefined();
    host.rows = [feature('new-a', 1, 'extrude')];
    host.error = new BreakpointHit({ filePath: FILE, line: 2, column: 1 });
    const paused = await server.updateLiveCode(FILE, PAUSED);
    expect(paused?.result).toHaveLength(1);
    expect(paused?.timeline).toEqual([
      { kind: 'evaluated', index: 0 },
      { kind: 'unevaluated', row: expect.objectContaining({ id: 'b', name: 'Computed b', sourceLocation: { filePath: FILE, line: 3, column: 1 } }) },
    ]);
    expect(JSON.stringify(paused?.timeline)).not.toContain('largeMesh');
    expect((await server.rollbackFromUI(0))?.timeline).toEqual(paused?.timeline);
    // Another document resets the server's current pause flag; the dedup hit
    // must restore it along with the history before the next rollback.
    host.error = null;
    host.rows = [];
    await server.updateLiveCode('/ws/other.part.js', '');
    const loads = host.loads;
    const hit = await server.updateLiveCode(FILE, PAUSED);
    expect(host.loads).toBe(loads);
    expect(hit?.timeline).toEqual(paused?.timeline);
    expect((await server.rollbackFromUI(0))?.breakpointHit).toBe(true);
    expect(sceneStopFields(paused!)).toMatchObject({ breakpointHit: true, timeline: paused!.timeline });
    host.error = new BreakpointHit({ filePath: FILE, line: 2, column: 1 });
    host.rows = [feature('again-a', 1, 'extrude')];
    expect((await server.updateLiveCode(FILE, PAUSED + '\n'))?.timeline?.[1]).toEqual(paused?.timeline?.[1]);
  });

  it('keeps the last evaluated history across an exception and clears it after completion', async () => {
    const { host, server } = setup();
    host.rows = [feature('a', 1, 'extrude'), feature('b', 2, 'fillet')];
    await server.updateLiveCode(FILE, FULL);
    host.error = new Error('broken source');
    await expect(server.updateLiveCode(FILE, 'broken(')).rejects.toThrow('broken source');
    host.rows = [feature('new-a', 1, 'extrude')];
    host.error = new BreakpointHit(null);
    expect((await server.updateLiveCode(FILE, PAUSED))?.timeline).toHaveLength(2);
    host.error = null;
    expect((await server.updateLiveCode(FILE, 'extrude(1);'))?.timeline).toBeUndefined();
    expect((await server.rollbackFromUI(0))?.timeline).toBeUndefined();
    host.error = new BreakpointHit(null);
    host.rows = [];
    const next = await server.updateLiveCode(FILE, 'breakpoint();\nextrude(1);');
    expect(next?.timeline).toHaveLength(1);
  });

  it('does not invent history after a server restart', async () => {
    const { host, server } = setup();
    host.error = new BreakpointHit(null);
    host.rows = [feature('a', 1, 'extrude')];
    expect((await server.updateLiveCode(FILE, PAUSED))?.timeline).toBeUndefined();
  });

  it('keeps the source breakpoint boundary when a rollback previews an earlier row', async () => {
    const { host, server } = setup();
    host.error = new BreakpointHit(null);
    host.rows = [feature('a', 1, 'extrude'), feature('b', 2, 'fillet')];
    const paused = await server.updateLiveCode(FILE, 'extrude(1);\nfillet(2);\nbreakpoint();');
    expect(paused?.breakpointStop).toBe(1);
    const preview = await server.rollbackFromUI(0);
    expect(sceneStopFields(preview!)).toMatchObject({ rollbackStop: 0, breakpointStop: 1, breakpointHit: true });
  });

  it('does not replace history with labels from an evaluation whose source changed in flight', async () => {
    const { host, server } = setup();
    host.rows = [feature('a', 1, 'extrude'), feature('b', 2, 'fillet')];
    await server.updateLiveCode(FILE, FULL);
    host.rows = [feature('superseded-a', 1, 'extrude')];
    host.duringLoad = () => host.setBuffer(`virtual:live-render:${FILE}`, PAUSED);
    await server.updateLiveCode(FILE, FULL + '\n');
    host.duringLoad = undefined;
    host.error = new BreakpointHit(null);
    const paused = await server.updateLiveCode(FILE, PAUSED);
    expect(paused?.timeline).toContainEqual({ kind: 'unevaluated', row: expect.objectContaining({ name: 'Computed b' }) });
  });
});
