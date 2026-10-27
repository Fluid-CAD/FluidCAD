// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The Translate dialog: the transform gizmo stands at the picked solids'
// center, carried by the distances; a drag slides the ghost live and writes
// only the axes it moved on release; Escape reverts a drag without closing
// the dialog; a clicked arrow types its axis' distance — a declaration
// included; at rest nothing is written; and the edit dialog reopens a
// statement with its distances, reading its target as it stood before.

/** The in-scope variables the dialogs offer — what the arithmetic reads names through. */
const VARIABLES: Record<string, number> = { h: 5 };

vi.mock('../src/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api')>()),
  getScopeVariables: vi.fn(async () => Object.entries(VARIABLES)
    .map(([name, value]) => ({ name, initializer: String(value), numeric: true }))),
  fetchFeatureSources: vi.fn(async () => ({ ok: false, reason: 'unused' })),
  fetchTranslateGhost: vi.fn(async (request: { translation: (number | string)[] }) => ({
    solids: [],
    translation: request.translation.map(value => typeof value === 'number' ? value : VARIABLES[value]),
  })),
  applyTranslate: vi.fn(async () => ({ success: true, preview: 'translate(…)' })),
  applyTranslateEdit: vi.fn(async () => ({ success: true, preview: 'translate(…)' })),
  rollback: vi.fn(),
  continueBreakpoint: vi.fn(),
}));

import { Box3, Object3D, PerspectiveCamera, Raycaster, Scene, Vector2, Vector3 } from 'three';
import { applyTranslate, applyTranslateEdit, fetchTranslateGhost } from '../src/api';
import { TranslateFeatureService } from '../src/interactive/create-feature/translate-service';
import { distanceValue, ghostDistance, isAtRest } from '../src/interactive/create-feature/translate-distances';
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

const W = 800;
const H = 600;
const FILE = '/ws/m.fluid.js';

/** The one solid on screen: the extrude at line 4, centered on the origin. */
const SOLID_BOUNDS = new Box3(new Vector3(-5, -5, -5), new Vector3(5, 5, 5));

function scene(withTranslateRow = false): SceneObjectRender[] {
  const rows = [{
    id: 'o1', type: 'extrude', name: 'Extrude 1',
    sourceLocation: { filePath: FILE, line: 4, column: 0 },
    sceneShapes: [{ shapeId: 's1', shapeType: 'solid', meshes: [] }],
  }];
  if (withTranslateRow) {
    rows.push({
      id: 'o2', type: 'translate', name: 'Translate 1',
      sourceLocation: { filePath: FILE, line: 9, column: 0 },
      sceneShapes: [],
    });
  }
  return rows as unknown as SceneObjectRender[];
}

function makeRect(el: HTMLElement): void {
  el.getBoundingClientRect = () => ({
    left: 0, top: 0, right: W, bottom: H, width: W, height: H, x: 0, y: 0,
    toJSON: () => ({}),
  }) as DOMRect;
}

function pointer(type: string, clientX: number, clientY: number): PointerEvent {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY, button: 0, buttons: 1 });
  (e as any).pointerId = 1;
  return e as unknown as PointerEvent;
}

function mount() {
  const container = document.createElement('div');
  const canvas = document.createElement('canvas');
  container.appendChild(canvas);
  document.body.appendChild(container);
  makeRect(container);
  makeRect(canvas);
  (canvas as any).setPointerCapture = () => {};
  (canvas as any).releasePointerCapture = () => {};

  const camera = new PerspectiveCamera(50, W / H, 0.1, 1000);
  camera.position.set(40, 40, 40);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  const world = new Scene();
  const viewer = {
    pickFilter: 'all',
    pickSketchWires: false,
    pickAxes: false,
    pickPlanes: false,
    sceneContext: {
      scene: world,
      renderer: { domElement: canvas },
      camera,
      createPickingRaycaster: (ndcX: number, ndcY: number) => {
        const raycaster = new Raycaster();
        raycaster.setFromCamera(new Vector2(ndcX, ndcY), camera);
        return raycaster;
      },
      requestRender: () => {},
    },
    addClickInterceptor: () => () => {},
    addHoverSuppressor: () => () => {},
    clearHighlight: () => {},
    highlightEntities: () => {},
    suspendSketchEditing: () => {},
    resumeSketchEditing: () => {},
    shapeBounds: (ids: Iterable<string>) => [...ids].includes('s1') ? SOLID_BOUNDS.clone() : null,
  };
  const service = new TranslateFeatureService(container, viewer as unknown as Viewer, new Navbar(container));
  service.update(scene());

  const toClient = (point: Vector3) => {
    const p = point.clone().project(camera);
    return { x: ((p.x + 1) / 2) * W, y: ((1 - p.y) / 2) * H };
  };
  const gizmo = () => world.getObjectByName('transformGizmo') as Object3D | undefined;
  const ghost = () => world.getObjectByName('featureGhost')!;
  const field = (axis: 'x' | 'y' | 'z') => container.querySelector<HTMLInputElement>(`[data-role="distance-${axis}"]`)!;
  return {
    container,
    service,
    gizmo,
    ghost,
    field,
    /** The gizmo's center, or null while it is down. */
    gizmoAt: () => (gizmo()?.visible ? gizmo()!.position.clone() : null),
    type: (axis: 'x' | 'y' | 'z', text: string) => {
      field(axis).value = text;
      field(axis).dispatchEvent(new Event('input'));
    },
    pickSolid: () => service.handleClick('s1', { type: 'face', index: 0 }),
    /** Press on `from` (a world point on a handle) and drag to `to`; released unless told otherwise. */
    drag: (from: Vector3, to: Vector3, opts: { release?: boolean } = {}) => {
      // The app's render loop keeps world matrices current; the rig has no renderer.
      world.updateMatrixWorld(true);
      const a = toClient(from);
      const b = toClient(to);
      canvas.dispatchEvent(pointer('pointerdown', a.x, a.y));
      canvas.dispatchEvent(pointer('pointermove', (a.x + b.x) / 2, (a.y + b.y) / 2));
      canvas.dispatchEvent(pointer('pointermove', b.x, b.y));
      if (opts.release !== false) {
        canvas.dispatchEvent(pointer('pointerup', b.x, b.y));
      }
    },
    /** Press and release on `at` without moving — a click on a handle. */
    click: (at: Vector3) => {
      world.updateMatrixWorld(true);
      const p = toClient(at);
      canvas.dispatchEvent(pointer('pointerdown', p.x, p.y));
      canvas.dispatchEvent(pointer('pointerup', p.x, p.y));
    },
  };
}

const escape = () => document.body.dispatchEvent(
  new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
);

/** Let the scope-variable read and the debounced preview + ghost settle. */
const settle = () => vi.advanceTimersByTimeAsync(400);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  document.body.innerHTML = '';
});

describe('translate distances', () => {
  it('reads a literal as itself, the server stamp for its own text, and arithmetic otherwise', () => {
    const variables = [{ name: 'w', initializer: '40' }];
    const stamp = { exprs: ['w / 2', 0, 0] as [string, number, number], values: [33, 0, 0] as [number, number, number] };
    expect(distanceValue({ value: 12 }, 0, variables, stamp)).toBe(12);
    // The server read `w / 2` where the statement sits — a configuration's value wins.
    expect(distanceValue({ value: 'w / 2' }, 0, variables, stamp)).toBe(33);
    expect(distanceValue({ value: 'w * 2' }, 0, variables, stamp)).toBe(80);
    expect(distanceValue({ value: 'gap' }, 1, variables, null)).toBeNull();
    expect(distanceValue({ value: 'gap', newVariable: { name: 'gap', initializer: '7' } }, 1, variables, null)).toBe(7);
  });

  it('sends a pending declaration to the ghost as its number', () => {
    expect(ghostDistance({ value: 'w' }, [])).toBe('w');
    expect(ghostDistance({ value: 'gap', newVariable: { name: 'gap', initializer: "param('gap', 9)" } }, [])).toBe(9);
  });

  it('is at rest only while every distance is a literal zero', () => {
    expect(isAtRest([0, 0, 0])).toBe(true);
    expect(isAtRest([0, 'h', 0])).toBe(false);
    expect(isAtRest([0, 0, 2])).toBe(false);
  });
});

describe('TranslateFeatureService — gizmo', () => {
  it('stands the gizmo at the picked solids\' center, carried by the distances', async () => {
    const rig = mount();
    rig.service.enter();
    await settle();
    expect(rig.gizmoAt()).toBeNull();

    rig.pickSolid();
    expect(rig.gizmoAt()?.toArray()).toEqual([0, 0, 0]);

    rig.type('x', '12');
    rig.type('z', 'h');
    expect(rig.gizmoAt()?.toArray()).toEqual([12, 0, 5]);

    // A distance the gizmo can't read takes it down rather than misplace it.
    rig.type('y', '');
    expect(rig.gizmoAt()).toBeNull();
    rig.service.exit();
  });

  it('a drag slides the ghost live and writes only the axes it moved on release', async () => {
    const rig = mount();
    rig.service.enter();
    await settle();
    rig.pickSolid();
    rig.type('z', 'h');
    await settle();
    // The ghost was stamped at (0, 0, 5) and lies where the distances say.
    expect(rig.ghost().visible).toBe(true);
    expect(rig.ghost().position.toArray()).toEqual([0, 0, 0]);

    // Grab the X arrow and pull it 5 along +X.
    rig.drag(new Vector3(4, 0, 5), new Vector3(9, 0, 5), { release: false });
    expect(rig.ghost().position.x).toBeCloseTo(5, 6);
    expect(rig.gizmoAt()!.x).toBeCloseTo(5, 6);
    // Nothing is written mid-drag.
    expect(rig.field('x').value).toBe('0');

    rig.drag(new Vector3(9, 0, 5), new Vector3(9, 0, 5));
    expect(rig.field('x').value).toBe('5');
    // The untouched axes keep their text — an expression included.
    expect(rig.field('y').value).toBe('0');
    expect(rig.field('z').value).toBe('h');

    rig.container.querySelector<HTMLButtonElement>('[data-role="apply"]')!.click();
    await settle();
    expect(applyTranslate).toHaveBeenLastCalledWith(expect.objectContaining({
      targets: [{ filePath: FILE, line: 4, column: 0 }],
      translation: [5, 0, 'h'],
      copy: false,
    }));
  });

  it('Escape reverts a drag without closing the dialog', async () => {
    const rig = mount();
    rig.service.enter();
    await settle();
    rig.pickSolid();

    rig.drag(new Vector3(4, 0, 0), new Vector3(9, 0, 0), { release: false });
    expect(rig.gizmoAt()!.x).toBeCloseTo(5, 6);
    escape();

    expect(rig.service.isActive).toBe(true);
    expect(rig.gizmoAt()?.toArray()).toEqual([0, 0, 0]);
    expect(rig.field('x').value).toBe('0');

    // The next Escape is the dialog's.
    escape();
    expect(rig.service.isActive).toBe(false);
    expect(rig.gizmoAt()).toBeNull();
  });

  it('a clicked arrow types its axis\' distance, declaring a variable on the way', async () => {
    const rig = mount();
    rig.service.enter();
    await settle();
    rig.pickSolid();

    rig.click(new Vector3(0, 0, 4));
    const input = rig.container.querySelector<HTMLInputElement>('.expression-input')!;
    input.value = 'lift = 12';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));

    expect(rig.field('z').value).toBe('lift');
    expect(rig.gizmoAt()?.toArray()).toEqual([0, 0, 12]);

    await settle();
    // The ghost gets the number the variable is being declared as.
    expect(fetchTranslateGhost).toHaveBeenLastCalledWith(
      expect.objectContaining({ translation: [0, 0, 12] }), null, expect.anything(),
    );
    rig.container.querySelector<HTMLButtonElement>('[data-role="apply"]')!.click();
    await settle();
    expect(applyTranslate).toHaveBeenLastCalledWith(expect.objectContaining({
      translation: [0, 0, 'lift'],
      newVariables: [expect.objectContaining({ name: 'lift' })],
    }));
  });

  it('an arrow\'s input committed unchanged keeps the declaration its field carries', async () => {
    const rig = mount();
    rig.service.enter();
    await settle();
    rig.pickSolid();
    rig.type('x', 'gap = 20');
    expect(rig.gizmoAt()?.toArray()).toEqual([20, 0, 0]);

    rig.click(new Vector3(24, 0, 0));
    await vi.advanceTimersByTimeAsync(0);
    const input = rig.container.querySelector<HTMLInputElement>('.expression-input')!;
    expect(input.value).toBe('gap');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));

    rig.container.querySelector<HTMLButtonElement>('[data-role="apply"]')!.click();
    await settle();
    expect(applyTranslate).toHaveBeenLastCalledWith(expect.objectContaining({
      translation: ['gap', 0, 0],
      newVariables: [expect.objectContaining({ name: 'gap' })],
    }));
  });

  it('at rest writes nothing: no statement preview, and Apply asks for a distance', async () => {
    const rig = mount();
    rig.service.enter();
    rig.pickSolid();
    await settle();
    // The bodies are fetched for the first drag, but drawn nowhere yet.
    expect(fetchTranslateGhost).toHaveBeenCalled();
    expect(rig.ghost().visible).toBe(false);

    rig.container.querySelector<HTMLButtonElement>('[data-role="apply"]')!.click();
    await settle();
    expect(applyTranslate).not.toHaveBeenCalled();
    expect(rig.service.isActive).toBe(true);
    expect(rig.container.textContent).toContain('Drag the gizmo');
  });
});

describe('TranslateFeatureService — edit', () => {
  it('reopens a statement with its distances, reading its target as it stood before', async () => {
    const rig = mount();
    rig.service.update(scene(true));
    const target = { filePath: FILE, line: 9, column: 0 };
    rig.service.enterEdit(target, {
      feature: 'translate',
      translation: [20, 0, 'h'],
      copy: true,
      targetTexts: ['e'],
      targetRefs: [{ line: 4, column: 0 }],
    }, { index: 1, type: 'translate', expectedStatement: 'translate(20, 0, h, true, e)' });
    // The session's rollback lands just before the statement.
    rig.service.handleSceneRendered(scene(true), 0, true);
    await settle();

    expect([rig.field('x').value, rig.field('y').value, rig.field('z').value]).toEqual(['20', '0', 'h']);
    expect(rig.gizmoAt()?.toArray()).toEqual([20, 0, 5]);
    expect(fetchTranslateGhost).toHaveBeenLastCalledWith(
      expect.objectContaining({ exclude: { filePath: FILE, line: 9 }, translation: [20, 0, 'h'] }),
      expect.objectContaining({ kind: 'statement', line: 9 }),
      expect.anything(),
    );

    rig.type('x', '25');
    rig.container.querySelector<HTMLButtonElement>('[data-role="apply"]')!.click();
    await settle();
    expect(applyTranslateEdit).toHaveBeenLastCalledWith(target, expect.objectContaining({
      translation: [25, 0, 'h'],
      copy: true,
      targets: [{ kind: 'feature', filePath: FILE, line: 4, column: 0 }],
      expectedStatement: 'translate(20, 0, h, true, e)',
    }));
  });
});
