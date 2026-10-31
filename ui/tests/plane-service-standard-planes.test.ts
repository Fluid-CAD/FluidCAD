// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

// The Plane dialog's origin-plane quads: all three are pick targets while the
// base list has room; once it is full only the chosen origin planes stay in
// the viewport (the ghost's reference) and the rest step aside; the edge type
// shows none; and a shown base quad clicks off, which reopens the list.

vi.mock('../src/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api')>()),
  getScopeVariables: vi.fn(async () => []),
  fetchSketchNames: vi.fn(async (lines: number[]) => lines.map(() => null)),
  fetchFeatureGhost: vi.fn(async () => null),
  fetchFeatureSources: vi.fn(async () => ({ ok: false })),
  applyPlane: vi.fn(async () => ({ success: true })),
  applyPlaneEdit: vi.fn(async () => ({ success: true })),
  rollback: vi.fn(),
  clearBreakpoints: vi.fn(),
}));

import { Scene } from 'three';
import * as api from '../src/api';
import { PlaneFeatureService } from '../src/interactive/create-feature/plane-service';
import { Navbar } from '../src/ui/navbar';
import type { SelectedEntity, Viewer } from '../src/viewer';
import type { StandardPlaneId } from '../src/scene/standard-planes';
import type { SceneObjectRender } from '../src/types';

// The toolbar measures itself with a ResizeObserver, which jsdom lacks.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof ResizeObserver === 'undefined') {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub;
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

/**
 * A viewer that records what the dialog asks the origin-plane quads to do —
 * `shown` mirrors the real viewer's contract (naming no plane is a hide) —
 * and hands back the pick handler so a test can click a quad.
 */
function stubViewer() {
  const state = {
    shown: [] as readonly StandardPlaneId[],
    onPick: null as ((plane: StandardPlaneId) => void) | null,
  };
  const viewer = {
    pickFilter: 'all',
    pickSketchWires: false,
    pickPlanes: false,
    missedSketchRender: false,
    sceneContext: { scene: new Scene(), requestRender: () => {} },
    suspendSketchEditing: () => {},
    resumeSketchEditing: () => {},
    highlightEntities: () => {},
    clearHighlight: () => {},
    showStandardPlanes: (onPick: (plane: StandardPlaneId) => void, opts: { only?: readonly StandardPlaneId[] } = {}) => {
      const planes = opts.only ?? ['xy', 'xz', 'yz'];
      if (planes.length === 0) {
        viewer.hideStandardPlanes();
        return;
      }
      // The viewer takes a set and draws it in xy/xz/yz order.
      state.shown = (['xy', 'xz', 'yz'] as const).filter(id => planes.includes(id));
      state.onPick = onPick;
    },
    hideStandardPlanes: () => {
      state.shown = [];
      state.onPick = null;
    },
  };
  return { viewer: viewer as unknown as Viewer, state };
}

function face(shapeId: string, index: number): SelectedEntity {
  return { shapeId, sub: { type: 'face', index } };
}

function mount(seed: SelectedEntity[] = []) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const { viewer, state } = stubViewer();
  const service = new PlaneFeatureService(container, viewer, new Navbar(container), {
    onEnter: () => ({ entities: seed }),
  });
  const setType = (type: 'offset' | 'mid' | 'edge') => {
    const select = container.querySelector<HTMLSelectElement>('[data-role="type"]')!;
    select.value = type;
    select.dispatchEvent(new Event('change'));
  };
  const clickQuad = (plane: StandardPlaneId) => {
    expect(state.shown).toContain(plane);
    state.onPick!(plane);
  };
  const clickFace = (entity: SelectedEntity) => service.handleClick(entity.shapeId, entity.sub);
  const removeChip = (index: number) => {
    const buttons = container.querySelectorAll<HTMLElement>('[data-role="bases-slot"] button[title="Remove this selection"]');
    buttons[index].click();
  };
  const shown = () => [...state.shown];
  return { service, state, setType, clickQuad, clickFace, removeChip, shown };
}

describe('PlaneFeatureService — origin-plane quads', () => {
  it('a mid plane keeps every quad until both bases are in, then only the chosen ones', () => {
    const { service, setType, clickQuad, shown } = mount();
    service.enter();
    setType('mid');
    expect(shown()).toEqual(['xy', 'xz', 'yz']);

    clickQuad('xy');
    // One of two: the second base's own target has to stay on screen.
    expect(shown()).toEqual(['xy', 'xz', 'yz']);

    clickQuad('xz');
    expect(shown()).toEqual(['xy', 'xz']);
    service.exit();
  });

  it('a full mid plane on two faces shows no quad; freeing a base brings them all back', () => {
    const { service, setType, clickFace, shown } = mount();
    service.enter();
    setType('mid');
    clickFace(face('s1', 0));
    clickFace(face('s1', 1));
    expect(shown()).toEqual([]);

    // Clicking a picked face removes it.
    clickFace(face('s1', 1));
    expect(shown()).toEqual(['xy', 'xz', 'yz']);
    service.exit();
  });

  it('a mid plane between a face and an origin plane keeps that one quad', () => {
    const { service, setType, clickFace, clickQuad, shown, removeChip } = mount();
    service.enter();
    setType('mid');
    clickFace(face('s1', 0));
    clickQuad('yz');
    expect(shown()).toEqual(['yz']);

    // The chip's ✕ frees the slot.
    removeChip(1);
    expect(shown()).toEqual(['xy', 'xz', 'yz']);
    service.exit();
  });

  it('a shown base quad clicks off, reopening the list', () => {
    const { service, setType, clickQuad, shown, state } = mount();
    service.enter();
    setType('mid');
    clickQuad('xy');
    clickQuad('yz');
    expect(shown()).toEqual(['xy', 'yz']);

    clickQuad('xy');
    expect(shown()).toEqual(['xy', 'xz', 'yz']);
    // And the freed slot takes a new origin plane.
    state.onPick!('xz');
    expect(shown()).toEqual(['xz', 'yz']);
    service.exit();
  });

  it('seeding with two faces opens a full mid plane, quads already aside', () => {
    const { service, shown } = mount([face('s1', 0), face('s1', 2)]);
    service.enter();
    expect(shown()).toEqual([]);
    service.exit();
  });

  it('an offset plane keeps only its origin-plane base, and no quad over a face base', () => {
    const { service, clickQuad, clickFace, shown } = mount();
    service.enter();
    expect(shown()).toEqual(['xy', 'xz', 'yz']);

    clickQuad('xz');
    expect(shown()).toEqual(['xz']);

    // A single-base type swaps on the next pick — a face here.
    clickFace(face('s1', 0));
    expect(shown()).toEqual([]);
    service.exit();
  });

  it('changing the type re-fits the quads to the trimmed list', () => {
    const { service, setType, clickQuad, shown } = mount();
    service.enter();
    setType('mid');
    clickQuad('xy');
    clickQuad('xz');
    expect(shown()).toEqual(['xy', 'xz']);

    // Mid → offset keeps the first base only: full, so just its quad.
    setType('offset');
    expect(shown()).toEqual(['xy']);

    // Offset → mid: room for a second base again.
    setType('mid');
    expect(shown()).toEqual(['xy', 'xz', 'yz']);

    // The edge type's base is a curve — no quad ever helps.
    setType('edge');
    expect(shown()).toEqual([]);
    service.exit();
  });

  it('leaving the dialog takes the quads with it', () => {
    const { service, setType, clickQuad, shown, state } = mount();
    service.enter();
    setType('mid');
    clickQuad('xy');
    service.exit();
    expect(shown()).toEqual([]);
    expect(state.onPick).toBeNull();
  });
});

// The Axes row as an expression: a plane whose statement holds `axes: flag ?
// 'local' : 'world'` opens the row in expression mode, and the service passes
// the expression through — to the ghost body, the statement preview and the
// apply payload — unchanged, for the server to resolve and to write back bare.
describe('PlaneFeatureService — a rotation-axes expression', () => {
  const filePath = '/ws/plane.fluid.js';

  it('carries the statement\'s axes expression to the ghost, the preview and the edit payload as it was', async () => {
    vi.useFakeTimers();
    try {
      const { service } = mount();
      const target = { filePath, line: 12, column: 1 };
      service.enterEdit(target, {
        feature: 'plane', type: 'offset', bases: [{ text: "'xy'", kind: 'plane', standard: 'xy', ref: null }],
        offset: 10, rotateX: 15, rotateY: null, rotateZ: null, rotationAxes: { expr: "flag ? 'local' : 'world'" }, position: null,
      }, { index: 3, type: 'plane', expectedStatement: "plane('xy', 10, { rotateX: 15, axes: flag ? 'local' : 'world' })" });
      expect(document.querySelector<HTMLButtonElement>('[data-role="expression-axes"]')!.getAttribute('aria-pressed')).toBe('true');
      // The session's rollback lands: the view at the pre-statement boundary
      // (the row's index less one), where the previews and ghost run.
      const rows = [0, 1, 2].map(i => ({ id: `row-${i}`, type: 'sketch', ownShapes: [], sceneShapes: [] }));
      service.handleSceneRendered([...rows, {
        id: 'plane', type: 'plane', sourceLocation: target, ownShapes: [], sceneShapes: [],
      }] as SceneObjectRender[], 2, true);
      await vi.runAllTimersAsync();
      const expected = expect.objectContaining({ rotationAxes: { expr: "flag ? 'local' : 'world'" }, rotateX: 15 });
      expect(api.fetchFeatureGhost).toHaveBeenLastCalledWith(expect.objectContaining({ feature: 'plane', rotationAxes: { expr: "flag ? 'local' : 'world'" } }),
        expect.anything(), expect.anything());
      expect(api.applyPlaneEdit).toHaveBeenLastCalledWith(target, expect.objectContaining({ preview: true }));
      expect(vi.mocked(api.applyPlaneEdit).mock.lastCall![1]).toEqual(expected);

      document.querySelector<HTMLButtonElement>('#fluidcad-plane-panel [data-role="apply"]')!.click();
      await vi.runAllTimersAsync();
      const applied = vi.mocked(api.applyPlaneEdit).mock.calls.find(([, options]) => !options.preview)!;
      expect(applied[0]).toEqual(target);
      expect(applied[1]).toEqual(expected);
      service.exit();
    } finally {
      vi.useRealTimers();
    }
  });
});
