// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Connector copies from the UI (connector-copies stage 2): the Copy dialog
// takes a connector — its gizmo, or its timeline row — as a target (a
// connector chip, written as `copy(…, bolt)`) or as an axis (its Z axis),
// ghosts the copies as connector triads, and sends connector targets and
// axes on the apply payload; the Repeat dialog refuses connectors at the
// pick, pointing to Copy (B9).

vi.mock('../src/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api')>()),
  getScopeVariables: vi.fn(async () => []),
  fetchSketchNames: vi.fn(async (lines: number[]) => lines.map(() => null)),
  fetchFeatureSources: vi.fn(async () => ({ ok: false })),
  fetchFeatureGhostResult: vi.fn(async () => ({ solids: null, frames: [], notice: null })),
  applyCopy: vi.fn(async () => ({ success: true, preview: 'copy(…)' })),
  applyCopyEdit: vi.fn(async () => ({ success: true, preview: 'copy(…)' })),
  applyRepeat: vi.fn(async () => ({ success: true, preview: 'repeat(…)' })),
}));

import { Group, PerspectiveCamera, Scene } from 'three';
import * as api from '../src/api';
import { CopyFeatureService } from '../src/interactive/create-feature/copy-service';
import { RepeatFeatureService } from '../src/interactive/create-feature/repeat-service';
import { collectRepeatTargets } from '../src/interactive/create-feature/repeat-targets';
import { Navbar } from '../src/ui/navbar';
import type { SceneObjectRender } from '../src/types';
import type { SelectionModifiers, Viewer } from '../src/viewer';

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
 * A flange part: a plate (a solid), `bolt`, `pivot` and `lug` declared on
 * it, and a connector-only `copy()` that made `lug.instance(1)`. `suffix`
 * re-mints every id — what a render does to rebuilt rows.
 */
function flangeScene(suffix = ''): SceneObjectRender[] {
  const id = (name: string) => `${name}${suffix}`;
  return [
    { id: id('part'), type: 'part', isContainer: true, sceneShapes: [], ownShapes: [], visible: true, sourceLocation: at(3, 22) },
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
      id: id('lug'), type: 'connector', name: 'lug', parentId: id('part'), visible: true, sceneShapes: [], ownShapes: [],
      object: { name: 'lug', ...FRAME, origin: { x: 0, y: 30, z: 10 } }, sourceLocation: at(8, 14),
    },
    {
      id: id('copy'), type: 'copy-linear', name: 'Copy', parentId: id('part'), visible: true, hideChildren: true,
      sceneShapes: [], ownShapes: [], sourceLocation: at(9, 2),
      object: { connectorCopies: { seeds: [{ id: id('lug'), name: 'lug' }], originalSlot: 0, slotCount: 2, slots: [1], connectorsOnly: true } },
    },
    {
      id: id('lug-1'), type: 'connector', name: 'lug.instance(1)', parentId: id('copy'), visible: true,
      sceneShapes: [], ownShapes: [], sourceLocation: at(9, 2),
      object: { name: 'lug', ...FRAME, origin: { x: 20, y: 30, z: 10 }, copy: { slot: 1, seedId: id('lug') } },
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
    hovered: null as string | null,
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
    clearHighlight: () => {},
    showStandardAxes: () => {},
    hideStandardAxes: () => {},
    showStandardPlanes: () => {},
    hideStandardPlanes: () => {},
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
    setHoveredConnector: (id: string | null) => {
      state.hovered = id;
    },
  };
  return { viewer: viewer as unknown as Viewer, state, scene };
}

function mountCopy() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const { viewer, state, scene } = stubViewer();
  const service = new CopyFeatureService(container, viewer, new Navbar(container), { onEnter: () => ({ seed: [] }) });
  service.update(flangeScene());
  const text = (role: string) => container.querySelector<HTMLElement>(`[data-role="${role}"]`)?.textContent ?? '';
  /** Each chip's hover title — its label element carries it (`Connector bolt` for a connector). */
  const chips = (role: string) => [...container.querySelectorAll<HTMLElement>(`[data-role="${role}"] span.truncate[title]`)]
    .map(el => el.getAttribute('title'));
  const setKind = (kind: 'linear' | 'circular') => {
    const select = container.querySelector<HTMLSelectElement>('[data-role="kind"]')!;
    select.value = kind;
    select.dispatchEvent(new Event('change'));
  };
  const armAxis = () => container.querySelector<HTMLElement>('[data-role="axis-slot-1"]')!.click();
  const ghostGroup = () => scene.getObjectByName('featureGhost') as Group;
  return { service, container, state, text, chips, setKind, armAxis, ghostGroup };
}

describe('Copy dialog — connectors', () => {
  it('arms connector picking with every gizmo revealed, and drops it on exit', () => {
    const { service, state } = mountCopy();
    service.enter();
    expect(state.connectorPicking).toEqual({ armed: true, reveal: true });

    service.exit();
    expect(state.connectorPicking).toEqual({ armed: false, reveal: false });
  });

  it('takes a connector gizmo into the targets as a connector chip, enlarged in the viewport', () => {
    const { service, text, chips, state } = mountCopy();
    service.enter();

    service.handleConnectorPick('bolt');

    expect(text('targets-slot')).toContain('bolt');
    expect(chips('targets-slot')).toContain('Connector bolt');
    expect(state.picked).toEqual(['bolt']);
    // Clicking it again takes it back off.
    service.handleConnectorPick('bolt');
    expect(text('targets-slot')).not.toContain('bolt');
    expect(state.picked).toEqual([]);
  });

  it('takes a connector row from the timeline the same way, beside a solid', () => {
    const { service, text, chips } = mountCopy();
    service.enter();

    expect(service.handleTimelinePick(rowOf('plate'))).toBe(true);
    expect(service.handleTimelinePick(rowOf('pivot'))).toBe(true);

    expect(text('targets-slot')).toContain('Extrude');
    expect(chips('targets-slot')).toContain('Connector pivot');
  });

  it("refuses a connector copy as a target, naming the seed to copy", () => {
    const { service, text } = mountCopy();
    service.enter();

    service.handleConnectorPick('lug-1');

    expect(text('message')).toContain('lug.instance(1) is itself a copy — copy lug instead');
    expect(text('targets-slot')).not.toContain('lug.instance(1)');
  });

  it('refuses a connector another copy() already copies — one copy statement per connector', () => {
    const { service, text } = mountCopy();
    service.enter();

    service.handleConnectorPick('lug');

    expect(text('message')).toBe(
      'lug is already copied by the copy on line 9 — one copy statement per connector: edit that one instead.',
    );
    expect(text('targets-slot')).not.toContain('lug');
  });

  it('asks which connector when several gizmos sit under the click', () => {
    const { service, container, chips, state } = mountCopy();
    service.enter();
    const pick: Pick<SelectionModifiers, 'clientX' | 'clientY' | 'connectorCandidates'> = {
      clientX: 100, clientY: 80,
      connectorCandidates: [{ instanceId: null, connectorId: 'bolt' }, { instanceId: null, connectorId: 'pivot' }],
    };

    service.handleConnectorPick('bolt', pick);

    const menu = container.querySelector<HTMLElement>('[data-role="connector-pick-menu"]')!;
    const rows = [...menu.querySelectorAll<HTMLButtonElement>('[data-index]')];
    expect(rows.map(row => row.textContent)).toEqual(['bolt', 'pivot']);
    rows[1].dispatchEvent(new MouseEvent('mouseenter'));
    expect(state.hovered).toBe('pivot');
    rows[1].click();
    expect(chips('targets-slot')).toEqual(['Connector pivot']);
  });

  it("takes a connector as the axis — its own, or a copy's", () => {
    const { service, text, chips, setKind, armAxis, state } = mountCopy();
    service.enter();
    setKind('circular');
    service.handleConnectorPick('bolt');
    armAxis();

    service.handleConnectorPick('pivot');
    expect(chips('axis-slot-1')).toEqual(['Connector pivot']);
    expect(state.picked).toEqual(['bolt', 'pivot']);

    // A copy stands for its own Z axis too.
    service.handleConnectorPick('lug-1');
    expect(text('axis-slot-1')).toContain('lug.instance(1)');
    // The pick stayed out of the targets.
    expect(chips('targets-slot')).toEqual(['Connector bolt']);
  });

  it('sends connector targets and a connector axis on the apply payload', async () => {
    const { service, container, setKind, armAxis } = mountCopy();
    service.enter();
    setKind('circular');
    service.handleConnectorPick('bolt');
    service.handleTimelinePick(rowOf('plate'));
    armAxis();
    service.handleConnectorPick('lug-1');

    container.querySelector<HTMLButtonElement>('[data-role="apply"]')!.click();
    await vi.runAllTimersAsync();

    const applied = vi.mocked(api.applyCopy).mock.calls.find(([options]) => !options.preview)![0];
    expect(applied).toMatchObject({
      kind: 'circular',
      targets: [{ kind: 'connector', ...at(6, 15) }, at(5, 12)],
      axis: { kind: 'connector', ...at(8, 14), slot: 1 },
      count: 3,
      sweep: { mode: 'angle', value: 360 },
    });
    expect(applied.targets[1]).not.toHaveProperty('kind');
  });

  it("ghosts the copies as connector triads, asking with the connector's call site and axis", async () => {
    vi.mocked(api.fetchFeatureGhostResult).mockResolvedValue({ solids: [], frames: [FRAME, FRAME], notice: null });
    const { service, setKind, armAxis, ghostGroup } = mountCopy();
    service.enter();
    setKind('circular');
    service.handleConnectorPick('bolt');
    armAxis();
    service.handleConnectorPick('pivot');

    await vi.advanceTimersByTimeAsync(300);

    const request = vi.mocked(api.fetchFeatureGhostResult).mock.calls.at(-1)![0];
    expect(request).toMatchObject({
      feature: 'copy',
      kind: 'circular',
      targets: [{ filePath: FILE, line: 6 }],
      axes: [{ kind: 'connector', filePath: FILE, line: 7 }],
      count: 3,
    });
    // Two triads, one per frame the kernel placed.
    expect(ghostGroup().children).toHaveLength(2);
    service.exit();
    expect(ghostGroup().children).toHaveLength(0);
  });

  it('re-finds connector picks after a render re-mints their ids', () => {
    const { service, chips, state, armAxis } = mountCopy();
    service.enter();
    service.handleConnectorPick('bolt');
    armAxis();
    service.handleConnectorPick('pivot');

    service.update(flangeScene('-r2'));

    expect(chips('targets-slot')).toEqual(['Connector bolt']);
    expect(chips('axis-slot-1')).toEqual(['Connector pivot']);
    expect(state.picked).toEqual(['bolt-r2', 'pivot-r2']);
  });

  it('opens on a connector for a connector row\'s "Copy…"', () => {
    const { service, chips } = mountCopy();

    service.enterWithConnector('pivot');

    expect(service.isActive).toBe(true);
    expect(chips('targets-slot')).toEqual(['Connector pivot']);
  });
});

describe('Repeat dialog — connectors (B9)', () => {
  function mountRepeat() {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const { viewer, state } = stubViewer();
    const service = new RepeatFeatureService(container, viewer, new Navbar(container), {});
    service.update(flangeScene());
    const text = (role: string) => container.querySelector<HTMLElement>(`[data-role="${role}"]`)?.textContent ?? '';
    return { service, state, text };
  }

  it('never offers a connector, or a copy of connectors, as a feature to repeat', () => {
    const offered = collectRepeatTargets(flangeScene()).map(option => option.line);
    expect(offered).toEqual([3, 5]);
  });

  it('refuses a connector row at the pick, pointing to Copy', () => {
    const { service, text } = mountRepeat();
    service.enter();

    expect(service.handleTimelinePick(rowOf('bolt'))).toBe(true);
    expect(text('message')).toBe('bolt is a connector — repeat re-applies features. Copy a connector with the Copy dialog instead.');

    expect(service.handleTimelinePick(rowOf('copy'))).toBe(true);
    expect(text('message')).toContain('Edit its pattern in the Copy dialog');
  });

  it('makes the gizmos on screen pickable only to refuse them, revealing none', () => {
    const { service, state, text } = mountRepeat();
    service.enter();
    expect(state.connectorPicking).toEqual({ armed: true, reveal: false });

    service.handleConnectorPick();
    expect(text('message')).toBe('Connectors are not repeated — repeat re-applies features. Copy a connector with the Copy dialog instead.');

    service.exit();
    expect(state.connectorPicking?.armed).toBe(false);
  });
});
