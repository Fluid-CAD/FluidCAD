// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The Hole dialog service: how each kind of pick — a connector gizmo or row,
// a sketch vertex dot, a scope solid — lands in the request, what the
// viewport is asked to offer while the dialog is up, and how an edit session
// seeds the statement's own placements. One dialog service per test file:
// the shared worker binds a service to the first file's api mock.

vi.mock('../src/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api')>()),
  getScopeVariables: vi.fn(async () => []),
  fetchSketchNames: vi.fn(async (lines: number[]) => lines.map(() => null)),
  fetchFeatureSources: vi.fn(async () => ({ ok: false, reason: 'none' })),
  fetchFeatureGhostResult: vi.fn(async () => ({ solids: null, frames: [], notice: null })),
  fetchConnectorAnchors: vi.fn(async () => ({ ok: false, reason: null })),
  applyHole: vi.fn(async () => ({ success: true, preview: 'hole(…)' })),
  applyHoleEdit: vi.fn(async () => ({ success: true, preview: 'hole(…)' })),
  rollback: vi.fn(),
  clearBreakpoints: vi.fn(),
}));

import { PerspectiveCamera, Scene } from 'three';
import * as api from '../src/api';
import { HoleFeatureService } from '../src/interactive/create-feature/hole/hole-service';
import { Navbar } from '../src/ui/navbar';
import { setActivePartLocationProvider } from '../src/helpers/scene-utils';
import type { ParsedFeatureStatement } from '../src/api';
import type { SceneObjectRender } from '../src/types';
import type { Viewer } from '../src/viewer';

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
  setActivePartLocationProvider(() => null);
  document.body.innerHTML = '';
});

const FILE = '/ws/plate.part.js';
const at = (line: number, column: number) => ({ filePath: FILE, line, column });

const FRAME = {
  xDirection: { x: 1, y: 0, z: 0 },
  yDirection: { x: 0, y: 1, z: 0 },
  normal: { x: 0, y: 0, z: 1 },
};

/**
 * A plate part with two connectors on its top face and a sketch on that face
 * holding one circle — its centre mark is the pickable sketch point.
 */
function plateScene(): SceneObjectRender[] {
  return [
    { id: 'part', type: 'part', isContainer: true, sceneShapes: [], ownShapes: [], visible: true, sourceLocation: at(3, 22) },
    {
      id: 'plate', type: 'extrude', name: 'Extrude', parentId: 'part', visible: true, ownShapes: [],
      sceneShapes: [{ shapeId: 'solid', shapeType: 'solid', meshes: [] }], sourceLocation: at(5, 12),
    },
    {
      id: 'bolt', type: 'connector', name: 'bolt', parentId: 'part', visible: true, sceneShapes: [], ownShapes: [],
      object: { name: 'bolt', ...FRAME, origin: { x: 20, y: 0, z: 10 } }, sourceLocation: at(6, 15),
    },
    {
      id: 'pivot', type: 'connector', name: 'pivot', parentId: 'part', visible: true, sceneShapes: [], ownShapes: [],
      object: { name: 'pivot', ...FRAME, origin: { x: -20, y: 0, z: 10 } }, sourceLocation: at(7, 16),
    },
    {
      id: 'sketch', type: 'sketch', name: 'Sketch', parentId: 'part', isContainer: true, visible: true,
      sceneShapes: [], ownShapes: [], sourceLocation: at(8, 12),
      object: { plane: { origin: { x: 0, y: 0, z: 10 }, center: { x: 0, y: 0, z: 10 }, ...FRAME } },
    },
    {
      id: 'circle', type: 'circle', name: 'Circle', parentId: 'sketch', visible: true, ownShapes: [],
      sceneShapes: [
        { shapeId: 'circle-edge', shapeType: 'edge', meshes: [], vertices: [] },
        { shapeId: 'circle-centre', shapeType: 'vertex', isMetaShape: true, meshes: [], vertices: [15, 5, 10] },
      ],
      sourceLocation: at(9, 4),
    },
  ] as SceneObjectRender[];
}

function rowOf(id: string): SceneObjectRender {
  return plateScene().find(row => row.id === id)!;
}

/** A viewer recording what the dialog asks of it. */
function stubViewer() {
  const scene = new Scene();
  const state = {
    connectorPicking: null as boolean | null,
    picked: [] as string[],
    vertexScope: undefined as unknown,
    highlighted: [] as unknown[],
  };
  const viewer = {
    pickFilter: 'all',
    pickSketchWires: false,
    pickVertices: false,
    pickAxes: false,
    pickPlanes: false,
    sceneContext: { scene, camera: new PerspectiveCamera(), requestRender: () => {} },
    suspendSketchEditing: () => {},
    resumeSketchEditing: () => {},
    highlightEntities: (entities: unknown[]) => {
      state.highlighted = entities;
    },
    clearHighlight: () => {},
    setConnectorPicking: (armed: boolean) => {
      state.connectorPicking = armed;
      if (!armed) {
        state.picked = [];
      }
    },
    setPickedConnectors: (ids: readonly string[]) => {
      state.picked = [...ids];
    },
    setHoveredConnector: () => {},
    setVertexPickScope: (scope: unknown) => {
      state.vertexScope = scope;
    },
  };
  return { viewer: viewer as unknown as Viewer, state };
}

function mount() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const { viewer, state } = stubViewer();
  // The scope picker offers the solids of the part the new statement lands in.
  setActivePartLocationProvider(() => at(3, 22));
  const service = new HoleFeatureService(container, viewer, new Navbar(container), { onEnter: () => {} });
  service.update(plateScene());
  const text = (role: string) => container.querySelector<HTMLElement>(`[data-role="${role}"]`)?.textContent ?? '';
  const chips = (role: string) => [...container.querySelectorAll<HTMLElement>(`[data-role="${role}"] span.truncate[title]`)]
    .map(el => el.getAttribute('title'));
  // The pick slot listens on its own mount — the host's last child, after the separator rule.
  const armScope = () => (container.querySelector<HTMLElement>('[data-role="scope-slot"]')!.lastElementChild as HTMLElement).click();
  /** The last statement preview the dialog asked for. */
  const lastPreview = () => {
    const calls = vi.mocked(api.applyHole).mock.calls;
    return calls.length > 0 ? calls[calls.length - 1][0] : null;
  };
  return { service, container, viewer, state, text, chips, armScope, lastPreview };
}

describe('Hole dialog service', () => {
  it('offers connectors, vertex dots and anchors together while placements are armed, and drops them on exit', () => {
    const { service, viewer, state } = mount();
    service.enter();
    expect(state.connectorPicking).toBe(true);
    expect(viewer.pickVertices).toBe(true);
    expect(state.vertexScope).toBeNull();
    expect(viewer.pickFilter).toBe('all');

    service.exit();
    expect(state.connectorPicking).toBe(false);
    expect(viewer.pickVertices).toBe(false);
  });

  it('takes a connector gizmo as a placement chip, drawn enlarged, and sends it by statement', async () => {
    const { service, chips, state, lastPreview } = mount();
    service.enter();

    service.handleConnectorPick('bolt');
    expect(chips('placements-slot')).toEqual(['Connector bolt']);
    expect(state.picked).toEqual(['bolt']);

    await vi.advanceTimersByTimeAsync(300);
    const request = lastPreview()!;
    expect(request.preview).toBe(true);
    expect(request.placements).toEqual([{ kind: 'connector', filePath: FILE, line: 6, column: 15 }]);
    expect(request.size).toEqual({ kind: 'fastener', label: 'M6' });
    expect(request.fastener).toEqual({ type: 'clearance', fit: 'normal' });
    expect(request.scope).toEqual([]);

    // Clicking it again takes it back off.
    service.handleConnectorPick('bolt');
    expect(chips('placements-slot')).toEqual([]);
    expect(state.picked).toEqual([]);
  });

  it('takes a timeline connector row as a placement and a solid row into the scope', async () => {
    const { service, chips, lastPreview } = mount();
    service.enter();

    expect(service.handleTimelinePick(rowOf('pivot'))).toBe(true);
    expect(service.handleTimelinePick(rowOf('plate'))).toBe(true);
    expect(chips('placements-slot')).toEqual(['Connector pivot']);
    expect(chips('scope-slot')).toEqual(['Extrude']);

    await vi.advanceTimersByTimeAsync(300);
    const request = lastPreview()!;
    expect(request.placements).toEqual([{ kind: 'connector', filePath: FILE, line: 7, column: 16 }]);
    expect(request.scope).toEqual([{ filePath: FILE, line: 5, column: 12 }]);
  });

  it('takes a sketch centre dot as a vertex placement and ghosts the tool at its frame', async () => {
    const { service, chips, lastPreview } = mount();
    service.enter();

    service.handleClick('circle-centre', { type: 'vertex', index: 0, position: { x: 15, y: 5, z: 10 } });
    expect(chips('placements-slot')).toEqual(['Circle centre · sketch line 8']);

    await vi.advanceTimersByTimeAsync(300);
    expect(lastPreview()!.placements).toEqual([
      { kind: 'vertex', entity: { shapeId: 'circle-centre', sub: { type: 'vertex', index: 0 } } },
    ]);
    const ghost = vi.mocked(api.fetchFeatureGhostResult).mock.calls.at(-1)![0];
    expect(ghost).toMatchObject({
      feature: 'hole',
      frames: [{ origin: [15, 5, 10], normal: [0, 0, 1] }],
      diameter: 6.6,
      depth: null,
      counterbore: null,
      countersink: null,
      scope: [],
    });
  });

  it('routes face clicks to the scope only while the scope slot is armed', () => {
    const { service, chips, armScope } = mount();
    service.enter();

    // Placements armed: a face click asks the anchor rail (nothing lands yet).
    service.handleClick('solid', { type: 'face', index: 0 });
    expect(chips('scope-slot')).toEqual([]);

    armScope();
    service.handleClick('solid', { type: 'face', index: 0 });
    expect(chips('scope-slot')).toEqual(['Extrude']);
  });

  it('asks for hole anchors and promises a connector only when the face is in a part', async () => {
    const faceAnchor = (inPart: boolean) => ({
      ok: true as const, inPart, defaultName: inPart ? 'c1' : null, args: 'e.endFaces()',
      anchors: [{ anchor: { kind: 'center' as const }, suffix: '.center()', frame: { origin: { x: 0, y: 0, z: 10 }, ...FRAME } }],
    });
    const { service, container, chips, lastPreview } = mount();
    const labels = () => [...container.querySelectorAll<HTMLElement>('[data-role="placements-slot"] span.truncate')]
      .map(el => el.textContent);
    service.enter();

    // Outside a part the hole takes the bare anchor expression.
    vi.mocked(api.fetchConnectorAnchors).mockResolvedValueOnce(faceAnchor(false));
    service.handleClick('solid', { type: 'face', index: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(api.fetchConnectorAnchors).mock.calls.at(-1)![2]).toBe('hole');
    expect(labels()).toEqual(['Face center']);
    expect(chips('placements-slot')).toEqual(['e.endFaces().center()']);
    await vi.advanceTimersByTimeAsync(300);
    expect(lastPreview()!.placements).toEqual([
      { kind: 'anchor', entity: { shapeId: 'solid', sub: { type: 'face', index: 0 } }, anchor: { kind: 'center' }, name: 'h1' },
    ]);

    // Inside a part the pick becomes a named connector.
    vi.mocked(api.fetchConnectorAnchors).mockResolvedValueOnce(faceAnchor(true));
    service.handleClick('solid', { type: 'face', index: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(labels()).toEqual(['Face center', 'Face center (new connector h2)']);
    expect(chips('placements-slot')[1]).toBe('e.endFaces().center() — a connector named h2 is created here');
  });

  it('refuses to apply without a placement, then applies the picked placements', async () => {
    const { service, container, text } = mount();
    service.enter();

    container.querySelector<HTMLButtonElement>('[data-role="apply"]')!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(text('message')).toContain('Pick where the holes go');
    expect(vi.mocked(api.applyHole).mock.calls.filter(call => !call[0].preview)).toHaveLength(0);

    service.handleConnectorPick('bolt');
    container.querySelector<HTMLButtonElement>('[data-role="apply"]')!.click();
    await vi.advanceTimersByTimeAsync(0);
    const applied = vi.mocked(api.applyHole).mock.calls.filter(call => !call[0].preview);
    expect(applied).toHaveLength(1);
    expect(applied[0][0].placements).toEqual([{ kind: 'connector', filePath: FILE, line: 6, column: 15 }]);
    expect(service.isActive).toBe(false);
  });

  it('seeds an edit session with the statement\'s own placements, resolving a connector argument to its chip, and ghosts them all', async () => {
    const { service, chips } = mount();
    const parsed: Extract<ParsedFeatureStatement, { feature: 'hole' }> = {
      feature: 'hole',
      size: { kind: 'fastener', label: 'M6' },
      fastener: { type: 'clearance', fit: 'close' },
      style: null,
      depth: null,
      tipAngle: null,
      placementTexts: ['bolt', 's.geometries.c.center()'],
      placementRefs: [{ line: 6, column: 15 }, null],
      scopeTexts: [],
      scopeRefs: [],
    };
    // The applied hole's row carries the frames its build cut at, one per argument.
    const scene = [...plateScene(), {
      id: 'hole', type: 'hole', name: 'Hole', parentId: 'part', visible: true, sceneShapes: [], ownShapes: [],
      object: {
        frames: [
          { origin: [20, 0, 10], normal: [0, 0, 1] },
          { origin: [15, 5, 10], normal: [0, 0, 1] },
        ],
      },
      sourceLocation: at(12, 0),
    } as unknown as SceneObjectRender];
    service.update(scene);
    service.enterEdit(at(12, 0), parsed, { index: 6, type: 'hole', expectedStatement: 'hole(…)' });
    expect(chips('placements-slot')).toEqual(['Current: bolt', 'Current: s.geometries.c.center()']);

    // Before the boundary render the kept arguments have no frame yet: no ghost.
    await vi.advanceTimersByTimeAsync(300);
    expect(api.fetchFeatureGhostResult).not.toHaveBeenCalled();

    // The rollback render at the boundary: the connector argument becomes its chip.
    service.handleSceneRendered(scene, 5, true);
    expect(chips('placements-slot')).toEqual(['Connector bolt', 'Current: s.geometries.c.center()']);

    await vi.advanceTimersByTimeAsync(300);
    const call = vi.mocked(api.applyHoleEdit).mock.calls.at(-1)!;
    expect(call[0]).toEqual(at(12, 0));
    // Untouched placements keep the statement's own arguments.
    expect(call[1].placements).toBeUndefined();
    expect(call[1].fastener).toEqual({ type: 'clearance', fit: 'close' });
    expect(call[1].scope).toEqual([]);

    // The connector ghosts at its own frame, the kept sketch point at the one its build cut at.
    const ghost = vi.mocked(api.fetchFeatureGhostResult).mock.calls.at(-1)![0];
    expect(ghost).toMatchObject({
      feature: 'hole',
      frames: [
        { origin: [20, 0, 10], normal: [0, 0, 1] },
        { origin: [15, 5, 10], normal: [0, 0, 1] },
      ],
      diameter: 6.4,
      depth: null,
      scope: [],
      exclude: { filePath: FILE, line: 12 },
    });
  });

  it('draws no edit ghost while a kept argument has no built frame', async () => {
    const { service } = mount();
    const parsed: Extract<ParsedFeatureStatement, { feature: 'hole' }> = {
      feature: 'hole',
      size: { kind: 'fastener', label: 'M6' },
      fastener: null,
      style: null,
      depth: null,
      tipAngle: null,
      placementTexts: ['e.endFaces().center()'],
      placementRefs: [null],
      scopeTexts: [],
      scopeRefs: [],
    };
    // A hole whose build failed serializes no frames.
    const scene = [...plateScene(), {
      id: 'hole', type: 'hole', name: 'Hole', parentId: 'part', visible: true, sceneShapes: [], ownShapes: [],
      object: { frames: [] }, sourceLocation: at(12, 0),
    } as unknown as SceneObjectRender];
    service.update(scene);
    service.enterEdit(at(12, 0), parsed, { index: 6, type: 'hole', expectedStatement: 'hole(…)' });
    service.handleSceneRendered(scene, 5, true);

    await vi.advanceTimersByTimeAsync(300);
    expect(api.applyHoleEdit).toHaveBeenCalled();
    expect(api.fetchFeatureGhostResult).not.toHaveBeenCalled();
  });
});
