// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Scene } from 'three';

vi.mock('../src/api', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/api')>()),
  getScopeVariables: vi.fn(async () => []),
  fetchSketchNames: vi.fn(async (lines: number[]) => lines.map(() => null)),
  fetchFeatureGhostResult: vi.fn(async () => ({ solids: [], notice: null })),
  fetchFeatureSources: vi.fn(async () => ({ ok: false })),
  applyLoft: vi.fn(async () => ({ success: true, preview: 'loft(a, b)' })),
  applyLoftEdit: vi.fn(async () => ({ success: true, preview: 'loft(a, b)' })),
  rollback: vi.fn(), clearBreakpoints: vi.fn(),
}));

import * as api from '../src/api';
import { LoftFeatureService } from '../src/interactive/create-feature/loft-service';
import { LoftConnections } from '../src/interactive/create-feature/loft-connections';
import { LoftConnectionsOverlay } from '../src/interactive/create-feature/loft-connections-overlay';
import { Navbar } from '../src/ui/navbar';
import type { SceneObjectRender } from '../src/types';
import type { Viewer } from '../src/viewer';

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', ResizeObserverStub);
const filePath = '/ws/loft.fluid.js';
const live: LoftFeatureService[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.mocked(api.fetchFeatureGhostResult).mockResolvedValue({ solids: [], notice: null });
  vi.mocked(api.fetchFeatureSources).mockResolvedValue({ ok: false, reason: 'unresolved' });
});
afterEach(() => {
  for (const service of live.splice(0)) {
    service.exit();
  }
  vi.useRealTimers();
  document.body.replaceChildren();
});

function fixture(): SceneObjectRender[] {
  return [0, 1, 2].flatMap(i => [{
    id: `sketch-${i}`, type: 'sketch', sourceLocation: { filePath, line: i * 10 + 1, column: 1 },
    ownShapes: [], sceneShapes: [],
  }, {
    id: `edge-${i}`, parentId: `sketch-${i}`, type: 'line', ownShapes: [], sceneShapes: [{
      shapeId: `edge-${i}`, shapeType: 'edge', vertices: [0, 0, i * 10, 5, 0, i * 10],
      meshes: [{ vertices: [0, 0, i * 10, 5, 0, i * 10], indices: [0, 1], normals: [] }],
    }],
  }]) as SceneObjectRender[];
}

function mount(scene = fixture()) {
  const container = document.createElement('div');
  document.body.append(container);
  const viewer = {
    sceneIsEmpty: false, pickFilter: 'all', pickSketchWires: false,
    sceneContext: { scene: new Scene(), requestRender: vi.fn() },
    suspendSketchEditing: vi.fn(), resumeSketchEditing: vi.fn(),
    highlightEntities: vi.fn(), clearHighlight: vi.fn(),
    setVertexPickScope: vi.fn(), setVertexPickEmphasis: vi.fn(),
  };
  const service = new LoftFeatureService(container, viewer as unknown as Viewer, new Navbar(container));
  live.push(service);
  service.update(scene);
  const panel = container.querySelector<HTMLElement>('#fluidcad-loft-panel')!;
  const arm = (slot: string) => panel.querySelector<HTMLElement>(`[data-role="${slot}-slot"]`)!.click();
  const pick = (profile: number, vertex = 0) => service.handleClick(`edge-${profile}`, {
    type: 'vertex', index: vertex, position: { x: vertex * 5, y: 0, z: profile * 10 },
  });
  const add = (index: number) => { arm('profiles'); service.handleTimelinePick(scene[index * 2]); };
  const remove = (slot: string, index: number) => panel.querySelectorAll<HTMLButtonElement>(
    `[data-role="${slot}-slot"] button[title="Remove this selection"]`)[index].click();
  const edit = (index: number) => panel.querySelectorAll<HTMLButtonElement>('[data-role="connections-slot"] button[aria-pressed]')[index].click();
  const apply = panel.querySelector<HTMLButtonElement>('[data-role="apply"]')!;
  const connections = () => panel.querySelector<HTMLElement>('[data-role="connections-slot"]')!.textContent!;
  const begin = (count = 2) => {
    service.enter();
    for (let i = 0; i < count; i++) {
      add(i);
    }
    arm('connections');
  };
  return { service, viewer, panel, scene, arm, pick, add, remove, edit, apply, connections, begin };
}

async function preview(): Promise<void> {
  await vi.advanceTimersByTimeAsync(300);
}

const parsed = {
  feature: 'loft' as const, op: 'new' as const, thin: null, profileTexts: ['a', 'b'], guideTexts: [],
  connectionTexts: [['a.geometries.l1.start()', 'b.geometries.l2.end()']],
  connectionArgs: ['a.geometries.l1.start(), /* keep */ b.geometries.l2.end()'],
  startCondition: null, endCondition: null, scopeTexts: [], scopeExplicit: false,
};

function openEdit(m: ReturnType<typeof mount>, resolved = true): void {
  vi.mocked(api.fetchFeatureSources).mockResolvedValue({ ok: true, feature: 'loft', guides: [],
    profiles: [1, 11].map(line => ({ kind: 'sketch', filePath, line, column: 1 })),
    connections: resolved ? [[[0, 0, 0], [0, 0, 10]]] : [],
  });
  m.service.enterEdit({ filePath, line: 31, column: 1 }, parsed,
    { index: 6, type: 'loft', expectedStatement: 'loft(a, b).connect(a0, b0)' });
}

describe('loft Connections dialog', () => {
  it('arms the vertex channel only for profile vertices and restores other slots', () => {
    const m = mount();
    m.begin();
    expect(m.viewer.pickFilter).toBe('vertex');
    expect(m.viewer.pickSketchWires).toBe(false);
    const scope = m.viewer.setVertexPickScope.mock.lastCall![0];
    expect(scope.map((v: { shapeId: string }) => v.shapeId)).toEqual(['edge-0', 'edge-0', 'edge-1', 'edge-1']);
    m.arm('profiles');
    expect(m.viewer.pickFilter).toBe('face');
    expect(m.viewer.pickSketchWires).toBe(true);
    m.service.exit();
    expect(m.viewer.pickFilter).toBe('all');
    expect(m.viewer.setVertexPickScope).toHaveBeenLastCalledWith(null);
  });

  it('fills in any order, replaces a filled profile, blocks incomplete apply and begins the next row', async () => {
    const m = mount();
    m.begin(3);
    m.pick(2);
    expect(m.connections()).toContain('1/3');
    expect(m.apply.disabled).toBe(true);
    m.pick(2, 1);
    m.pick(0);
    expect(m.connections()).toContain('2/3');
    m.pick(1);
    expect(m.apply.disabled).toBe(false);
    await preview();
    expect(api.fetchFeatureGhostResult).toHaveBeenLastCalledWith(expect.objectContaining({
      connections: [[[0, 0, 0], [0, 0, 10], [5, 0, 20]]],
    }), expect.any(AbortSignal));
    m.pick(0, 1);
    expect(m.connections()).toContain('C2');
    expect(m.apply.disabled).toBe(true);
    m.remove('connections', 1);
    expect(m.apply.disabled).toBe(false);
  });

  it('adding a profile opens every row and removing it preserves the other points', async () => {
    const m = mount();
    m.begin(); m.pick(0); m.pick(1);
    m.pick(0, 1); m.pick(1, 1);
    m.add(2);
    expect(m.connections().match(/2\/3/g)).toHaveLength(2);
    expect(m.apply.disabled).toBe(true);
    m.remove('profiles', 2);
    expect(m.apply.disabled).toBe(false);
    await preview();
    expect(api.fetchFeatureGhostResult).toHaveBeenLastCalledWith(expect.objectContaining({ connections: [
      [[0, 0, 0], [0, 0, 10]], [[5, 0, 0], [5, 0, 10]],
    ] }), expect.anything());
  });

  it('supports chip editing and refuses reuse by another row', () => {
    const m = mount();
    m.begin(); m.pick(0); m.pick(1);
    m.pick(0);
    expect(m.panel.textContent).toContain('already used by C1');
    expect(m.connections()).not.toContain('C2');
    m.edit(0); m.pick(0, 1);
    expect(m.connections()).not.toContain('C2');
    expect(m.apply.disabled).toBe(false);
  });

  it('ignores timeline profile/guide changes while the vertex slot is armed', () => {
    const m = mount();
    m.begin();
    m.service.handleTimelinePick(m.scene[4]);
    m.pick(2);
    expect(m.panel.textContent).toContain('Pick a vertex on one of the loft profiles.');
    expect(m.connections()).not.toContain('C1');
  });

  it('uses exact face membership for two profiles on the same solid', () => {
    const m = mount([{ id: 'body', type: 'extrude', ownShapes: [], sceneShapes: [{
      shapeId: 'body', shapeType: 'solid', meshes: [],
      vertices: [0, 0, 0, 5, 0, 0, 0, 0, 10, 5, 0, 10, 0, 0, 5], faceVertices: [[0, 1], [2, 3]],
    }] }]);
    m.service.enter();
    m.service.handleClick('body', { type: 'face', index: 0 });
    m.service.handleClick('body', { type: 'face', index: 1 });
    m.arm('connections');
    expect(m.viewer.setVertexPickScope).toHaveBeenLastCalledWith([0, 1, 2, 3].map(index => ({ shapeId: 'body', indices: [index] })));
    m.service.handleClick('body', { type: 'vertex', index: 4, position: { x: 0, y: 0, z: 5 } });
    expect(m.connections()).not.toContain('C1');
    m.service.handleClick('body', { type: 'vertex', index: 2, position: { x: 0, y: 0, z: 10 } });
    m.service.handleClick('body', { type: 'vertex', index: 0, position: { x: 0, y: 0, z: 0 } });
    expect(m.apply.disabled).toBe(false);
  });

  it('seeds verbatim rows, omits untouched connections and keeps individual points on edits', async () => {
    const m = mount();
    openEdit(m);
    await preview();
    expect(api.applyLoftEdit).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ connections: undefined }));
    m.arm('connections'); m.edit(0); m.pick(1, 1);
    await preview();
    expect(api.applyLoftEdit).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
      connections: [{ kind: 'points', points: [{ kind: 'verbatim', sourceIndex: 0, pointIndex: 0 },
        { kind: 'vertex', entity: { shapeId: 'edge-1', sub: { type: 'vertex', index: 1 } } }] }],
      before: { index: 6, type: 'loft', line: 31, column: 1 },
    }));
    m.remove('connections', 0);
    await preview();
    expect(api.applyLoftEdit).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ connections: [] }));
  });

  it('does not show a ghost when an original connection cannot resolve', async () => {
    const m = mount();
    openEdit(m, false);
    await preview();
    expect(api.fetchFeatureGhostResult).not.toHaveBeenCalled();
  });

  it('keeps the loft ghost and its matching up while a connection is being picked', async () => {
    const m = mount();
    const matchLine = [0, 0, 0, 0, 0, 10];
    vi.mocked(api.fetchFeatureGhostResult).mockResolvedValue({ solids: [{ meshes: [], matchLines: [matchLine] }], notice: null });
    m.begin(3);
    m.pick(0); m.pick(1); m.pick(2);
    await preview();
    const overlay = () => m.viewer.sceneContext.scene.getObjectByName('loft-connections')!.children;
    expect(overlay().length).toBeGreaterThan(0);

    // First vertex of a second connection: the row is incomplete, the ghost
    // request carries the finished row only — and is still made.
    vi.mocked(api.fetchFeatureGhostResult).mockClear();
    m.pick(0, 1);
    expect(m.apply.disabled).toBe(true);
    // Nothing blanks the preview while the debounce and the fetch run.
    expect(overlay().length).toBeGreaterThan(0);
    await preview();
    expect(api.fetchFeatureGhostResult).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.fetchFeatureGhostResult).mock.calls[0][0]).toMatchObject({
      connections: [[[0, 0, 0], [0, 0, 10], [0, 0, 20]]],
    });
    expect(overlay().length).toBeGreaterThan(0);
  });

  it('surfaces crossing errors and clears automatic matching, without accepting a stale response', async () => {
    const m = mount();
    m.begin(); m.pick(0); m.pick(1);
    vi.mocked(api.fetchFeatureGhostResult).mockResolvedValue({ solids: null, notice: 'Connections 1 and 2 cross.' });
    await preview();
    expect(m.panel.textContent).toContain('Connections 1 and 2 cross.');
    expect(m.viewer.sceneContext.scene.getObjectByName('loft-connections')!.children.every(child => child.userData.connectionRow !== null)).toBe(true);
    let finish!: (result: { solids: null; notice: string }) => void;
    vi.mocked(api.fetchFeatureGhostResult).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    m.edit(0); m.pick(1, 1);
    await preview();
    m.service.exit();
    finish({ solids: null, notice: 'Stale error' });
    await Promise.resolve();
    expect(m.panel.textContent).not.toContain('Stale error');
    expect(m.viewer.sceneContext.scene.getObjectByName('loft-connections')!.children).toHaveLength(0);
  });

  it('invalidates new vertex picks when scene identities change', () => {
    const m = mount();
    m.begin(); m.pick(0); m.pick(1);
    m.service.update(fixture());
    expect(m.apply.disabled).toBe(true);
    expect(m.connections()).toContain('0/2');
    expect(m.panel.textContent).toContain('Pick the connection vertices again');
  });

  it('does not offer a circular face seam as a connection vertex', () => {
    const m = mount([{ id: 'body', type: 'extrude', ownShapes: [], sceneShapes: [{
      shapeId: 'body', shapeType: 'solid', meshes: [],
      vertices: [5, 0, 0, 5, 0, 10], faceVertices: [[0], [1]],
    }] }]);
    m.service.enter();
    m.service.handleClick('body', { type: 'face', index: 0 });
    m.service.handleClick('body', { type: 'face', index: 1 });
    m.arm('connections');
    expect(m.viewer.setVertexPickScope).toHaveBeenLastCalledWith([]);
  });

  it('explains the current guide and thin-wall limits and blocks Apply', () => {
    const m = mount();
    m.begin(); m.pick(0); m.pick(1);
    const thin = m.panel.querySelector<HTMLInputElement>('[data-role="thin"]')!;
    thin.checked = true;
    thin.dispatchEvent(new Event('change'));
    expect(m.apply.disabled).toBe(true);
    expect(m.connections()).toContain('cannot be combined with thin walls');
    thin.checked = false;
    thin.dispatchEvent(new Event('change'));
    expect(m.apply.disabled).toBe(false);
    m.arm('guides');
    m.service.handleTimelinePick(m.scene[4]);
    expect(m.apply.disabled).toBe(true);
    expect(m.connections()).toContain('cannot be combined with guides');
    m.remove('guides', 0);
    expect(m.apply.disabled).toBe(false);
  });
});

describe('connection matching and profile remapping', () => {
  it('reorders original points and returns to an untouched argument list when restored', () => {
    const rows = new LoftConnections();
    rows.seed([['a', 'b', 'c']]);
    rows.resolve([[[0, 0, 0], [0, 0, 10], [0, 0, 20]]]);
    rows.remap([2, 0, 1]);
    expect(rows.refs(true)).toEqual([{ kind: 'points', points: [2, 0, 1].map(pointIndex => ({ kind: 'verbatim', sourceIndex: 0, pointIndex })) }]);
    expect(rows.completeWorldPoints()).toEqual([[[0, 0, 20], [0, 0, 0], [0, 0, 10]]]);
    rows.remap([1, 2, 0]);
    expect(rows.refs(true)).toBeUndefined();
  });

  it('replaces coincident automatic edges with the actual curved user edge and disposes on hide', () => {
    const m = mount();
    const overlay = new LoftConnectionsOverlay(m.viewer as unknown as Viewer);
    const rows = new LoftConnections();
    rows.seed([['a', 'b']]); rows.resolve([[[0, 0, 0], [0, 0, 10]]]);
    const curved = [0, 0, 0, 2, 0, 5, 0, 0, 10];
    overlay.setGhost([{ meshes: [], matchLines: [curved, [5, 0, 0, 5, 0, 10]] }]);
    overlay.set(rows.rows, 0, true);
    const group = m.viewer.sceneContext.scene.children.at(-1)!;
    expect(group.children.map(child => child.userData.connectionRow)).toEqual([0, null]);
    const line = group.children[0].children[0] as any;
    const dispose = vi.spyOn(line.geometry, 'dispose');
    expect(line.material.linewidth).toBe(3);
    overlay.set(rows.rows, 0, false);
    expect(group.children).toHaveLength(0);
    expect(dispose).toHaveBeenCalledOnce();
  });
});
