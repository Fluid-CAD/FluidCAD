// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The Sweep dialog's path takes a curve object whole. Its wire renders as
// regular edges, so a click on one of them is the object — written as its
// statement, in the slot a sketch path travels in — while an edge of a solid
// is a path edge pick. A helix is one curve object among others: the dialog
// asks what the row holds, not what made it. A loop is a path too: the
// right-click menu offers the loops of the faces an edge bounds and keeps
// the one chosen as a chain sent as a loop, and a double-click on a
// surface's rim edge takes the rim loop.

vi.mock('../src/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api')>()),
  getScopeVariables: vi.fn(async () => []),
  fetchSketchNames: vi.fn(async (lines: number[]) => lines.map(() => null)),
  fetchFeatureSources: vi.fn(async () => ({ ok: false })),
  fetchFeatureGhost: vi.fn(async () => null),
  applySweep: vi.fn(async () => ({ success: true, preview: 'sweep(…)' })),
  rollback: vi.fn(),
  clearBreakpoints: vi.fn(),
}));

import { PerspectiveCamera, Scene } from 'three';
import * as api from '../src/api';
import { SweepFeatureService } from '../src/interactive/create-feature/sweep-service';
import { Navbar } from '../src/ui/navbar';
import type { SceneObjectRender } from '../src/types';
import type { SelectedEntity, Viewer } from '../src/viewer';
import { FakeSelectionServer } from './fixtures/fake-selection-server';

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
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

const FILE = '/ws/spring.fluid.js';
const at = (line: number, column = 0) => ({ filePath: FILE, line, column });
const MESH = [{ vertices: [0, 0, 0, 1, 0, 0], normals: [], indices: [0, 1] }];

/** A profile sketch, a block, a helix, and a copied rail: a curve of several edges that is no helix. */
function scene(): SceneObjectRender[] {
  return [
    { id: 'sk', type: 'sketch', name: 'Sketch 1', isContainer: true, sceneShapes: [], ownShapes: [], sourceLocation: at(2) },
    {
      id: 'ring', type: 'offset', parentId: 'sk', ownShapes: [], sourceLocation: at(3),
      sceneShapes: [{ shapeId: 'ring-wire', shapeType: 'edge', meshes: MESH }],
    },
    {
      id: 'block', type: 'extrude', name: 'Extrude 1', ownShapes: [], sourceLocation: at(5),
      sceneShapes: [{ shapeId: 'block-solid', shapeType: 'solid', meshes: MESH }],
    },
    {
      id: 'coil', type: 'helix', name: 'Helix 1', ownShapes: [], sourceLocation: at(6),
      sceneShapes: [{ shapeId: 'coil-edge', shapeType: 'edge', meshes: MESH }],
    },
    {
      id: 'rail', type: 'copy-linear', name: 'Copy 1', ownShapes: [], sourceLocation: at(7),
      sceneShapes: [{ shapeId: 'rail-wire', shapeType: 'wire', meshes: MESH }],
    },
  ];
}

function stubViewer(): Viewer {
  return {
    pickFilter: 'all',
    pickSketchWires: false,
    missedSketchRender: false,
    sceneIsEmpty: false,
    isRegionPicking: false,
    sceneContext: { scene: new Scene(), camera: new PerspectiveCamera(), requestRender: () => {} },
    suspendSketchEditing: () => {},
    resumeSketchEditing: () => {},
    highlightEntities: () => {},
    clearHighlight: () => {},
    clearHover: () => {},
  } as unknown as Viewer;
}

function mount() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const service = new SweepFeatureService(container, stubViewer(), new Navbar(container));
  service.update(scene());
  service.enter();
  const pathChips = () => [...container.querySelectorAll<HTMLElement>('[data-role="path-slot"] span.truncate[title]')]
    .map(el => el.textContent);
  const edge = (shapeId: string, index = 0) => service.handleClick(shapeId, { type: 'edge', index });
  const sentPath = async () => {
    await vi.advanceTimersByTimeAsync(300);
    return vi.mocked(api.applySweep).mock.calls.at(-1)![0].path;
  };
  return { service, pathChips, edge, sentPath };
}

describe('Sweep — a curve object as the path', () => {
  it('a click on a helix\'s edge takes the helix, sent as a sketch path is', async () => {
    const { service, pathChips, edge, sentPath } = mount();
    edge('coil-edge');
    expect(pathChips()).toEqual(['Helix 1']);
    expect(await sentPath()).toEqual({ kind: 'sketch', ...at(6) });
    service.exit();
  });

  it('a click on an edge of any other curve object takes that object the same way', async () => {
    const { service, pathChips, edge, sentPath } = mount();
    // The path opens on the first wire source that is not the profile.
    expect(pathChips()).toEqual(['Helix 1']);
    edge('rail-wire', 2);
    expect(pathChips()).toEqual(['Copy 1']);
    expect(await sentPath()).toEqual({ kind: 'sketch', ...at(7) });
    service.exit();
  });

  it('a click on an edge of a solid is a path edge pick', async () => {
    const { service, pathChips, edge, sentPath } = mount();
    edge('block-solid', 4);
    expect(pathChips()).toEqual(['Edge']);
    expect(await sentPath()).toEqual({
      kind: 'edges',
      entities: [{ shapeId: 'block-solid', sub: { type: 'edge', index: 4 } }],
      chains: [],
    });
    service.exit();
  });

  it('a curve object\'s timeline row lands in the path whichever slot is armed, and never as the profile', async () => {
    const { service, pathChips, sentPath } = mount();
    expect(service.handleTimelinePick(scene().find(row => row.id === 'rail')!)).toBe(true);
    expect(pathChips()).toEqual(['Copy 1']);
    expect(await sentPath()).toEqual({ kind: 'sketch', ...at(7) });
    expect(vi.mocked(api.applySweep).mock.calls.at(-1)![0].profile).toMatchObject({ line: 2 });
    service.exit();
  });
});

describe('Sweep — a loop as the path', () => {
  const edgeOf = (shapeId: string, index: number): SelectedEntity => ({ shapeId, sub: { type: 'edge', index } });
  const FACE_LOOP = [0, 1, 2, 3].map(i => edgeOf('block-solid', i));

  it('the right-click menu offers the loops of the faces an edge bounds, and keeps the one chosen as a chain sent as a loop', async () => {
    const server = new FakeSelectionServer().install();
    server.groups = [
      { kind: 'tangent', label: 'Tangent Edges', members: FACE_LOOP.slice(0, 2) },
      { kind: 'loop', label: 'Outer Loop of Plane 1', members: FACE_LOOP },
      { kind: 'loop', label: 'Outer Loop of Plane 2', members: [0, 4, 5, 6].map(i => edgeOf('block-solid', i)) },
      { kind: 'same-type', label: 'All Lines', members: FACE_LOOP.slice(0, 3) },
    ];
    const { service, pathChips, sentPath } = mount();
    service.handleContextMenu('block-solid', { type: 'edge', index: 1 }, 10, 10);
    await vi.advanceTimersByTimeAsync(0);
    const items = [...document.querySelectorAll<HTMLButtonElement>('#fluidcad-sweep-pick-menu button')];
    // A path is one connected chain: loops, never scattered same-type edges.
    expect(items.map(b => b.textContent)).toEqual(['Tangent Edges (2)', 'Outer Loop of Plane 1 (4)', 'Outer Loop of Plane 2 (4)']);
    items[1].click();
    expect(pathChips()).toEqual(['Loop (4 edges)']);
    expect(await sentPath()).toEqual({
      kind: 'edges', entities: FACE_LOOP, chains: [{ seed: edgeOf('block-solid', 1), members: FACE_LOOP, kind: 'loop' }],
    });
    service.exit();
  });

  it('a double-click on a surface\'s rim edge takes the rim loop, as plain picks', async () => {
    const rim = [1, 2, 5].map(i => edgeOf('sheet', i));
    const server = new FakeSelectionServer().install();
    server.loop = () => ({ rim: true, members: rim });
    const { service, pathChips, edge, sentPath } = mount();
    edge('sheet', 2);
    edge('sheet', 2);
    await service.handleDoubleClick('sheet', { type: 'edge', index: 2 });
    expect(server.count('api/selection/expand-bucket')).toBe(0);
    expect(pathChips()).toEqual(['Edge', 'Edge', 'Edge']);
    expect(await sentPath()).toEqual({ kind: 'edges', entities: rim, chains: [] });
    service.exit();
  });
});
