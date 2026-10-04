// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Every axis slot takes a connector — its Z axis through its origin. While
// the Revolve, Rotate or Helix dialog has its axis slot armed, every
// connector gizmo is revealed and pickable, and a gizmo click (or a
// connector's timeline row) lands in the slot as that connector's chip; the
// apply writes it by its `connector()` call site, a copy with its slot, and
// the ghost turns around it. An edit whose axis is a connector shows the
// connector's chip and keeps the statement's text. (Repeat and Copy are
// covered in copy-dialog-connectors.test.ts: each dialog service keeps to one
// test file, since the shared worker binds a service to the first file's api
// mock.)

vi.mock('../src/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api')>()),
  getScopeVariables: vi.fn(async () => []),
  fetchSketchNames: vi.fn(async (lines: number[]) => lines.map(() => null)),
  fetchFeatureSources: vi.fn(async () => ({ ok: false })),
  fetchFeatureGhost: vi.fn(async () => null),
  applyRevolve: vi.fn(async () => ({ success: true, preview: 'revolve(…)' })),
  applyRevolveEdit: vi.fn(async () => ({ success: true, preview: 'revolve(…)' })),
  applyRotate: vi.fn(async () => ({ success: true, preview: 'rotate(…)' })),
  applyHelix: vi.fn(async () => ({ success: true, preview: 'helix(…)' })),
  rollback: vi.fn(),
  clearBreakpoints: vi.fn(),
}));

import { PerspectiveCamera, Scene } from 'three';
import * as api from '../src/api';
import { HelixFeatureService } from '../src/interactive/create-feature/helix-service';
import { RevolveFeatureService } from '../src/interactive/create-feature/revolve-service';
import { RotateFeatureService } from '../src/interactive/create-feature/rotate-service';
import { Navbar } from '../src/ui/navbar';
import type { SceneObjectRender } from '../src/types';
import type { Viewer } from '../src/viewer';

// The toolbar measures itself with a ResizeObserver, which jsdom lacks.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof ResizeObserver === 'undefined') {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  document.body.innerHTML = '';
});

const FILE = '/ws/flange.part.js';

const at = (line: number, column: number) => ({ filePath: FILE, line, column });

const FRAME = {
  origin: { x: 30, y: 0, z: 10 },
  xDirection: { x: 1, y: 0, z: 0 },
  yDirection: { x: 0, y: 1, z: 0 },
  normal: { x: 0, y: 0, z: 1 },
};

/**
 * A flange part: a profile sketch, a plate (a solid), `bolt` and `pivot`
 * on it, and a `copy()` that made `bolt.instance(1)`. `suffix` re-mints
 * every id — what a render does to rebuilt rows.
 */
function flangeScene(suffix = ''): SceneObjectRender[] {
  const id = (name: string) => `${name}${suffix}`;
  return [
    { id: id('part'), type: 'part', isContainer: true, sceneShapes: [], ownShapes: [], visible: true, sourceLocation: at(3, 22) },
    {
      id: id('profile'), type: 'sketch', name: 'Sketch', parentId: id('part'), visible: true, ownShapes: [],
      sceneShapes: [{ shapeId: id('wire'), shapeType: 'wire', meshes: [{}] }], sourceLocation: at(4, 12),
    },
    {
      id: id('plate'), type: 'extrude', name: 'Extrude', parentId: id('part'), visible: true, ownShapes: [],
      sceneShapes: [{ shapeId: id('solid'), shapeType: 'solid', meshes: [] }], sourceLocation: at(5, 12),
    },
    {
      id: id('bolt'), type: 'connector', name: 'bolt', parentId: id('part'), visible: true, sceneShapes: [], ownShapes: [],
      object: { name: 'bolt', ...FRAME }, sourceLocation: at(6, 15),
    },
    {
      id: id('pivot'), type: 'connector', name: 'pivot', parentId: id('part'), visible: true, sceneShapes: [], ownShapes: [],
      object: { name: 'pivot', ...FRAME, origin: { x: -20, y: 0, z: 10 } }, sourceLocation: at(7, 16),
    },
    {
      id: id('copy'), type: 'copy-linear', name: 'Copy', parentId: id('part'), visible: true, hideChildren: true,
      sceneShapes: [], ownShapes: [], sourceLocation: at(8, 2),
      object: { connectorCopies: { seeds: [{ id: id('bolt'), name: 'bolt' }], originalSlot: 0, slotCount: 2, slots: [1], connectorsOnly: true } },
    },
    {
      id: id('bolt-1'), type: 'connector', name: 'bolt.instance(1)', parentId: id('copy'), visible: true,
      sceneShapes: [], ownShapes: [], sourceLocation: at(8, 2),
      object: { name: 'bolt', ...FRAME, origin: { x: 30, y: 20, z: 10 }, copy: { slot: 1, seedId: id('bolt') } },
    },
  ] as SceneObjectRender[];
}

/** A row of the flange by its id. */
function rowOf(id: string): SceneObjectRender {
  return flangeScene().find(row => row.id === id)!;
}

/** A viewer recording what the dialogs ask of it. */
function stubViewer() {
  const scene = new Scene();
  const state = {
    connectorPicking: null as { armed: boolean; reveal: boolean } | null,
    picked: [] as string[],
  };
  const viewer = {
    pickFilter: 'all',
    pickSketchWires: false,
    pickAxes: false,
    pickPlanes: false,
    missedSketchRender: false,
    sceneIsEmpty: false,
    sceneContext: { scene, camera: new PerspectiveCamera(), requestRender: () => {} },
    suspendSketchEditing: () => {},
    resumeSketchEditing: () => {},
    highlightEntities: () => {},
    highlightPlaneQuad: () => {},
    highlightShapes: () => {},
    clearHighlight: () => {},
    showStandardAxes: () => {},
    hideStandardAxes: () => {},
    setSelectedStandardAxes: () => {},
    setConnectorPicking: (armed: boolean, opts: { reveal?: boolean } = {}) => {
      state.connectorPicking = { armed, reveal: armed && (opts.reveal ?? true) };
      if (!armed) {
        state.picked = [];
      }
    },
    setPickedConnectors: (ids: readonly string[]) => {
      state.picked = [...ids];
    },
    setHoveredConnector: () => {},
  };
  return { viewer: viewer as unknown as Viewer, state };
}

/** A dialog's DOM, read the way a user sees it. */
function dom(container: HTMLElement) {
  return {
    text: (role: string) => container.querySelector<HTMLElement>(`[data-role="${role}"]`)?.textContent ?? '',
    /** Each chip's hover title — a connector's reads `Connector bolt`. */
    chips: (role: string) => [...container.querySelectorAll<HTMLElement>(`[data-role="${role}"] span.truncate[title]`)]
      .map(el => el.getAttribute('title')),
    click: (role: string) => container.querySelector<HTMLElement>(`[data-role="${role}"]`)!.click(),
  };
}

function mount<S>(make: (container: HTMLElement, viewer: Viewer) => S) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const { viewer, state } = stubViewer();
  const service = make(container, viewer);
  return { service, state, ...dom(container) };
}

describe('Revolve — a connector axis', () => {
  const revolve = () => mount((container, viewer) => {
    const service = new RevolveFeatureService(container, viewer, new Navbar(container));
    service.update(flangeScene());
    return service;
  });

  it('reveals the gizmos while the axis slot is armed, and a gizmo click is the axis', () => {
    const { service, state, chips, click } = revolve();
    service.enter();
    expect(service.isConnectorPicking).toBe(true);
    expect(state.connectorPicking).toEqual({ armed: true, reveal: true });

    service.handleConnectorPick('bolt');
    expect(chips('axis-slot')).toEqual(['Connector bolt']);
    expect(state.picked).toEqual(['bolt']);

    // The profile slot armed: no gizmo is pickable, and a stray pick is ignored.
    click('profile-slot');
    expect(service.isConnectorPicking).toBe(false);
    expect(state.connectorPicking?.armed).toBe(false);
    service.handleConnectorPick('pivot');
    expect(chips('axis-slot')).toEqual(['Connector bolt']);

    service.exit();
    expect(state.connectorPicking?.armed).toBe(false);
  });

  it('takes a connector row as the axis, a copy by its seed and slot, and writes it so', async () => {
    const { service, chips, text, state } = revolve();
    service.enter();
    expect(service.handleTimelinePick(rowOf('bolt-1'))).toBe(true);
    expect(text('axis-slot')).toContain('bolt.instance(1)');
    expect(state.picked).toEqual(['bolt-1']);

    await vi.advanceTimersByTimeAsync(300);
    const preview = vi.mocked(api.applyRevolve).mock.calls.at(-1)![0];
    expect(preview.axis).toEqual({ kind: 'connector', ...at(6, 15), slot: 1 });
    // The ghost turns around the copy's Z axis.
    expect(vi.mocked(api.fetchFeatureGhost).mock.calls.at(-1)![0]).toMatchObject({
      feature: 'revolve', axis: { kind: 'connector', filePath: FILE, line: 6, slot: 1 },
    });

    // A render re-mints the ids: the pick is found again by its site.
    service.update(flangeScene('-r2'));
    expect(chips('axis-slot')).toEqual(['Connector bolt.instance(1)']);
    expect(state.picked).toEqual(['bolt-1-r2']);
  });

  it("opens an edit whose axis is a connector on that connector's chip, kept as written", async () => {
    vi.mocked(api.fetchFeatureSources).mockResolvedValue({
      ok: true, feature: 'revolve',
      profile: { kind: 'sketch', ...at(4, 12) },
      axis: { kind: 'connector', ...at(6, 15), slot: 1 },
    });
    const { service, chips, text, state } = revolve();
    const target = at(10, 2);
    service.enterEdit(target, {
      feature: 'revolve', op: 'add', angle: null, symmetric: false, thin: null,
      axisText: 'bolt.instance(1)', profileText: 's', scopeTexts: [], scopeRefs: [], regions: [],
    } as never, { index: 7, type: 'revolve', expectedStatement: 'revolve(bolt.instance(1), s)' });
    expect(text('axis-slot')).toContain('Current: bolt.instance(1)');
    const edited = {
      id: 'edited', type: 'revolve', name: 'Revolve', parentId: 'part', visible: true, sceneShapes: [], ownShapes: [], sourceLocation: target,
    } as SceneObjectRender;
    service.handleSceneRendered([...flangeScene(), edited], 7, true);
    await vi.runAllTimersAsync();

    expect(chips('axis-slot')).toEqual(['Connector bolt.instance(1)']);
    expect(text('axis-slot')).not.toContain('Current:');
    expect(state.picked).toEqual(['bolt-1']);
    expect(vi.mocked(api.fetchFeatureGhost).mock.calls.at(-1)![0]).toMatchObject({
      feature: 'revolve', axis: { kind: 'connector', filePath: FILE, line: 6, slot: 1 },
    });
    // Untouched, the edit sends no axis: the statement keeps `bolt.instance(1)`.
    const edit = vi.mocked(api.applyRevolveEdit).mock.calls.at(-1)![1];
    expect(edit.axis).toBeUndefined();
    service.exit();
  });
});

describe('Rotate — a connector axis', () => {
  const rotate = () => mount((container, viewer) => {
    const service = new RotateFeatureService(container, viewer, new Navbar(container), { onEnter: () => ({ seed: [] }) });
    service.update(flangeScene());
    return service;
  });

  it('arms the gizmos with the axis slot, and sends the connector it took', async () => {
    const { service, state, chips, click } = rotate();
    service.enter();
    // The Solids slot opens armed: no gizmo to pick.
    expect(service.isConnectorPicking).toBe(false);
    expect(service.handleTimelinePick(rowOf('plate'))).toBe(true);

    click('axis-slot');
    expect(service.isConnectorPicking).toBe(true);
    expect(state.connectorPicking).toEqual({ armed: true, reveal: true });
    service.handleConnectorPick('pivot');
    expect(chips('axis-slot')).toEqual(['Connector pivot']);
    expect(state.picked).toEqual(['pivot']);

    await vi.advanceTimersByTimeAsync(300);
    expect(vi.mocked(api.applyRotate).mock.calls.at(-1)![0]).toMatchObject({
      targets: [at(5, 12)],
      axis: { kind: 'connector', ...at(7, 16) },
    });
    service.exit();
  });
});

describe('Helix — a connector axis', () => {
  const helix = () => mount((container, viewer) => {
    const service = new HelixFeatureService(container, viewer, new Navbar(container));
    service.update(flangeScene());
    return service;
  });

  it('takes a connector in axis mode, and none in face mode', async () => {
    const { service, state, chips } = helix();
    service.enter();
    expect(service.isConnectorPicking).toBe(true);
    expect(state.connectorPicking).toEqual({ armed: true, reveal: true });
    service.handleConnectorPick('bolt-1');
    expect(chips('axis-slot')).toEqual(['Connector bolt.instance(1)']);

    await vi.advanceTimersByTimeAsync(300);
    expect(vi.mocked(api.applyHelix).mock.calls.at(-1)![0]).toMatchObject({
      source: { kind: 'connector', ...at(6, 15), slot: 1 },
    });
    expect(vi.mocked(api.fetchFeatureGhost).mock.calls.at(-1)![0]).toMatchObject({
      feature: 'helix', source: { kind: 'connector', filePath: FILE, line: 6, slot: 1 },
    });

    // The From-face tab picks faces: the gizmos go away.
    const faceTab = [...document.querySelectorAll<HTMLButtonElement>('[data-role="mode-tabs"] button')]
      .find(button => /face/i.test(button.textContent ?? ''))!;
    faceTab.click();
    expect(service.isConnectorPicking).toBe(false);
    expect(state.connectorPicking?.armed).toBe(false);
    service.exit();
  });
});
