// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Connector copies from the UI (connector-copies stage 2): the Copy dialog
// takes a connector — its gizmo, or its timeline row — as a target (a
// connector chip, written as `copy(…, bolt)`) or as an axis (its Z axis),
// ghosts the copies as connector triads, and sends connector targets and
// axes on the apply payload; the Repeat dialog refuses connectors at the
// pick, pointing to Copy (B9). Stage 4 adds "Along a repeat", the follow
// form `copy(holes, bolt)` — tested here too: each dialog service keeps to
// one test file, since the shared worker binds a service to the first
// file's api mock.

vi.mock('../src/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api')>()),
  getScopeVariables: vi.fn(async () => []),
  // Only the flange's `holes` repeat (line 8) is bound to a variable.
  fetchSketchNames: vi.fn(async (lines: number[], callee?: string) =>
    lines.map(line => (callee === 'repeat' && line === 8 ? 'holes' : null))),
  fetchFeatureSources: vi.fn(async () => ({ ok: false })),
  fetchFeatureGhostResult: vi.fn(async () => ({ solids: null, frames: [], notice: null })),
  applyCopy: vi.fn(async () => ({ success: true, preview: 'copy(…)' })),
  applyCopyEdit: vi.fn(async () => ({ success: true, preview: 'copy(…)' })),
  applyRepeat: vi.fn(async () => ({ success: true, preview: 'repeat(…)' })),
  rollback: vi.fn(),
  clearBreakpoints: vi.fn(),
}));

import { Group, PerspectiveCamera, Scene } from 'three';
import * as api from '../src/api';
import { CopyFeatureService } from '../src/interactive/create-feature/copy-service';
import { PatternOptions } from '../src/interactive/create-feature/pattern-options';
import { RepeatFeatureService } from '../src/interactive/create-feature/repeat-service';
import { collectRepeatTargets } from '../src/interactive/create-feature/repeat-targets';
import { Navbar } from '../src/ui/navbar';
import type { ParsedFeatureStatement } from '../src/api';
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

  it('ghosts an edited copy as soon as it reopens, before any field changes', async () => {
    vi.mocked(api.fetchFeatureGhostResult).mockResolvedValue({ solids: [], frames: [FRAME, FRAME], notice: null });
    const { service, ghostGroup } = mountCopy();
    const target = at(10, 2);
    service.enterEdit(target, {
      feature: 'copy', kind: 'circular', axisTexts: ["'z'"], axisRefs: [null], directions: null, spacingMode: null,
      centered: false, count: 6, sweep: { mode: 'angle', value: 360 }, center: null, skip: null,
      targetTexts: ['bolt'], targetRefs: [{ line: 6, column: 15 }],
    }, { index: 7, type: 'copy-circular', expectedStatement: "copy('circular', 'z', { count: 6, angle: 360 }, bolt)" });
    const edited = {
      id: 'edited', type: 'copy-circular', name: 'Copy', parentId: 'part', visible: true, hideChildren: true,
      sceneShapes: [], ownShapes: [], sourceLocation: target,
    } as SceneObjectRender;
    service.handleSceneRendered([...flangeScene(), edited], 6, true);
    await vi.runAllTimersAsync();

    const request = vi.mocked(api.fetchFeatureGhostResult).mock.calls.at(-1)?.[0];
    expect(request).toMatchObject({
      feature: 'copy', kind: 'circular', targets: [{ filePath: FILE, line: 6 }],
      axes: [{ kind: 'standard', axis: 'z' }], count: 6,
    });
    expect(ghostGroup().children).toHaveLength(2);
    service.exit();
  });

  it('ghosts an edited copy whose kept axis is an inline axis(<edge>), turning the edge it was built on', async () => {
    // What an edge pick writes: the axis lands inline, so the sources query
    // answers with the edge it names rather than a statement.
    vi.mocked(api.fetchFeatureSources).mockResolvedValue({
      ok: true, feature: 'copy',
      targets: [{ kind: 'sketch', ...at(6, 15) }],
      axes: [{ kind: 'entities', entities: [{ shapeId: 'solid', sub: { type: 'edge', index: 3 } }] }],
    });
    vi.mocked(api.fetchFeatureGhostResult).mockResolvedValue({ solids: [], frames: [FRAME, FRAME, FRAME], notice: null });
    const { service, text, ghostGroup } = mountCopy();
    const target = at(10, 2);
    service.enterEdit(target, {
      feature: 'copy', kind: 'linear', axisTexts: ["axis(e.startEdges(edge().farthest('z')))"], axisRefs: [null],
      directions: [{ count: 4, value: -200 }], spacingMode: 'offset', centered: false, count: null, sweep: null,
      center: null, skip: null, targetTexts: ['bolt'], targetRefs: [{ line: 6, column: 15 }],
    }, {
      index: 7, type: 'copy-linear',
      expectedStatement: "copy('linear', axis(e.startEdges(edge().farthest('z'))), { count: 4, offset: -200 }, bolt)",
    });
    expect(text('axis-slot-1')).toContain('Current: axis(');
    const edited = {
      id: 'edited', type: 'copy-linear', name: 'Copy', parentId: 'part', visible: true, hideChildren: true,
      sceneShapes: [], ownShapes: [], sourceLocation: target,
    } as SceneObjectRender;
    service.handleSceneRendered([...flangeScene(), edited], 6, true);
    await vi.runAllTimersAsync();

    const request = vi.mocked(api.fetchFeatureGhostResult).mock.calls.at(-1)?.[0];
    expect(request).toMatchObject({
      feature: 'copy', kind: 'linear', targets: [{ filePath: FILE, line: 6 }],
      axes: [{ kind: 'edge', shapeId: 'solid', index: 3 }],
      directions: [{ count: 4, offset: -200, length: null }],
    });
    expect(ghostGroup().children).toHaveLength(3);
    service.exit();
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

// ---------------------------------------------------------------------------
// Along a repeat (stage 4): the follow form `copy(holes, bolt)`.
// ---------------------------------------------------------------------------

/**
 * A flange part: a plate, a hole cut through it and `holes`, a circular
 * repeat of it — its last clone owns the flange's body — a mirror repeat, a
 * rotate repeat, a standalone boss (a solid), and the connectors `bolt` and
 * `pivot`. `suffix` re-mints every id — what a render does to rebuilt rows.
 */
function followScene(suffix = ''): SceneObjectRender[] {
  const id = (name: string) => `${name}${suffix}`;
  const base = { ownShapes: [], visible: true, sceneShapes: [] };
  return [
    { ...base, id: id('part'), type: 'part', isContainer: true, sourceLocation: at(3, 22) },
    { ...base, id: id('plate'), type: 'extrude', name: 'Extrude', parentId: id('part'), sourceLocation: at(5, 12) },
    { ...base, id: id('hole'), type: 'cut', name: 'Cut', parentId: id('part'), sourceLocation: at(7, 15) },
    {
      ...base, id: id('holes'), type: 'repeat-circular', uniqueType: 'repeat-circular', name: 'Repeat',
      parentId: id('part'), isContainer: true, hideChildren: true, sourceLocation: at(8, 16),
    },
    { ...base, id: id('hole-1'), type: 'cut', name: 'Cut', parentId: id('holes'), sourceLocation: at(8, 16) },
    {
      ...base, id: id('hole-2'), type: 'cut', name: 'Cut', parentId: id('holes'), sourceLocation: at(8, 16),
      sceneShapes: [{ shapeId: id('flange-solid'), shapeType: 'solid', meshes: [] }],
    },
    {
      ...base, id: id('mirrored'), type: 'mirror', uniqueType: 'mirror-feature', name: 'Repeat',
      parentId: id('part'), sourceLocation: at(9, 2),
    },
    {
      ...base, id: id('turned'), type: 'repeat-matrix', uniqueType: 'repeat-matrix', name: 'Repeat',
      parentId: id('part'), sourceLocation: at(10, 2),
    },
    {
      ...base, id: id('boss'), type: 'extrude', name: 'Boss', parentId: id('part'), sourceLocation: at(11, 15),
      sceneShapes: [{ shapeId: id('boss-solid'), shapeType: 'solid', meshes: [] }],
    },
    {
      ...base, id: id('bolt'), type: 'connector', name: 'bolt', parentId: id('part'),
      object: { name: 'bolt', ...FRAME }, sourceLocation: at(12, 15),
    },
    {
      ...base, id: id('pivot'), type: 'connector', name: 'pivot', parentId: id('part'),
      object: { name: 'pivot', ...FRAME, origin: { x: -20, y: 0, z: 10 } }, sourceLocation: at(13, 16),
    },
  ] as SceneObjectRender[];
}

/** A row of the followed flange by its id. */
function followRowOf(id: string): SceneObjectRender {
  return followScene().find(row => row.id === id)!;
}

/** A viewer recording what the Along a repeat dialog asks of it, the pick filter included. */
function followViewer() {
  const scene = new Scene();
  const state = {
    connectorPicking: null as { armed: boolean; reveal: boolean } | null,
    picked: [] as string[],
    pickFilter: 'all',
  };
  const viewer = {
    get pickFilter() {
      return state.pickFilter;
    },
    set pickFilter(value: string) {
      state.pickFilter = value;
    },
    pickSketchWires: false,
    pickAxes: false,
    pickPlanes: false,
    missedSketchRender: false,
    sceneIsEmpty: false,
    sceneContext: { scene, camera: new PerspectiveCamera(), requestRender: () => {} },
    suspendSketchEditing: () => {},
    resumeSketchEditing: () => {},
    highlightEntities: () => {},
    clearHighlight: () => {},
    showStandardAxes: () => {},
    hideStandardAxes: () => {},
    setSelectedStandardAxes: () => {},
    setConnectorPicking: (armed: boolean, opts: { reveal?: boolean } = {}) => {
      state.connectorPicking = { armed, reveal: armed && (opts.reveal ?? true) };
    },
    setPickedConnectors: (ids: readonly string[]) => {
      state.picked = [...ids];
    },
    setHoveredConnector: () => {},
  };
  return { viewer: viewer as unknown as Viewer, state, scene };
}

/** Every Along a repeat dialog a test opened — closed after it, so none lingers on the shared Escape stack. */
const opened: CopyFeatureService[] = [];

function mountFollow() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const { viewer, state, scene } = followViewer();
  const service = new CopyFeatureService(container, viewer, new Navbar(container), { onEnter: () => ({ seed: [] }) });
  opened.push(service);
  service.update(followScene());
  const el = (role: string) => container.querySelector<HTMLElement>(`[data-role="${role}"]`)!;
  const text = (role: string) => el(role)?.textContent ?? '';
  const hidden = (role: string) => el(role).classList.contains('hidden');
  const kindSelect = () => container.querySelector<HTMLSelectElement>('[data-role="kind"]')!;
  const patternOption = () => kindSelect().querySelector<HTMLOptionElement>('option[value="pattern"]')!;
  const setKind = (kind: 'linear' | 'circular' | 'pattern') => {
    kindSelect().value = kind;
    kindSelect().dispatchEvent(new Event('change'));
  };
  const apply = async () => {
    container.querySelector<HTMLButtonElement>('[data-role="apply"]')!.click();
    await vi.runAllTimersAsync();
  };
  const ghostGroup = () => scene.getObjectByName('featureGhost') as Group;
  return { service, container, state, text, hidden, kindSelect, patternOption, setKind, apply, ghostGroup };
}

describe('Copy dialog — Along a repeat', () => {
  afterEach(() => {
    for (const service of opened.splice(0)) {
      service.exit();
    }
  });

  it('is offered only while every target is a connector', () => {
    const { service, patternOption } = mountFollow();
    service.enter();
    expect(patternOption().textContent).toBe('Along a repeat');
    expect(patternOption().disabled).toBe(false);

    // A solid among the targets rules it out; taking it back off offers it again.
    service.handleTimelinePick(followRowOf('boss'));
    expect(patternOption().disabled).toBe(true);
    service.handleTimelinePick(followRowOf('boss'));
    expect(patternOption().disabled).toBe(false);

    service.handleConnectorPick('bolt');
    expect(patternOption().disabled).toBe(false);
  });

  it('hides the count, spacing, axis and skip fields and shows the Pattern slot', () => {
    const { service, hidden, text, setKind } = mountFollow();
    service.enter();
    expect(hidden('pattern-slot')).toBe(true);

    setKind('pattern');

    for (const role of ['axis-wrap', 'count-row', 'spacing-row', 'sweep-row', 'dir2-wrap', 'add-direction', 'centered-row', 'skip-row']) {
      expect(hidden(role), role).toBe(true);
    }
    expect(hidden('pattern-slot')).toBe(false);
    expect(text('pattern-slot')).toContain('Pick a repeat in the timeline, or a feature it repeated');

    setKind('circular');
    expect(hidden('pattern-slot')).toBe(true);
    expect(hidden('count-row')).toBe(false);
    expect(hidden('axis-wrap')).toBe(false);
  });

  it("takes a repeat's row into the Pattern slot, named by its variable", async () => {
    const { service, text, setKind } = mountFollow();
    service.enter();
    await vi.runAllTimersAsync();
    setKind('pattern');

    expect(service.handleTimelinePick(followRowOf('holes'))).toBe(true);

    expect(text('pattern-slot')).toContain('holes');
    expect(text('pattern-slot')).toContain('8');
    expect(text('message')).toBe('');
  });

  it('refuses a mirror, rotate or matrix repeat, and a row that is no repeat', () => {
    const { service, text, setKind } = mountFollow();
    service.enter();
    setKind('pattern');

    service.handleTimelinePick(followRowOf('mirrored'));
    expect(text('message')).toBe(
      "A mirror repeat can't be followed — a copied connector is never reflected. Pick a linear or circular repeat.",
    );
    service.handleTimelinePick(followRowOf('turned'));
    expect(text('message')).toBe("A rotate or matrix repeat can't be followed — pick a linear or circular repeat.");
    // A solid row is neither a repeat nor, along a repeat, a target.
    service.handleTimelinePick(followRowOf('boss'));
    expect(text('message')).toBe(
      "Along a repeat copies connectors onto a repeat's instances — pick a connector, or the repeat to follow.",
    );
    expect(text('targets-slot')).not.toContain('Boss');
    expect(text('pattern-slot')).toContain('Pick a repeat');
  });

  it('picks a repeated feature in the viewport — the repeat that placed the clicked shape', () => {
    const { service, text, setKind, state } = mountFollow();
    service.enter();
    setKind('pattern');
    // Faces and edges are pickable: they name the repeat.
    expect(state.pickFilter).toBe('all');

    service.handleClick('boss-solid', { type: 'face', index: 0 });
    expect(text('message')).toContain('That shape was not placed by a repeat');

    service.handleClick('flange-solid', { type: 'face', index: 3 });
    expect(text('pattern-slot')).toContain('Repeat');
    expect(text('message')).toBe('');
    expect(PatternOptions.forShape('flange-solid', followScene(), PatternOptions.collect(followScene())))
      .toEqual({ option: { id: 'holes', label: 'Repeat', ...at(8, 16) } });
  });

  it('sends the connectors and the repeat they follow on the apply payload — nothing else', async () => {
    const { service, setKind, apply } = mountFollow();
    service.enter();
    setKind('pattern');
    service.handleConnectorPick('bolt');
    service.handleConnectorPick('pivot');
    service.handleTimelinePick(followRowOf('holes'));

    await apply();

    const applied = vi.mocked(api.applyCopy).mock.calls.find(([options]) => !options.preview)![0];
    expect(applied).toEqual({
      kind: 'pattern',
      targets: [{ kind: 'connector', ...at(12, 15) }, { kind: 'connector', ...at(13, 16) }],
      pattern: at(8, 16),
    });
  });

  it('blocks the apply until a repeat is picked, and keeps its connectors after a render re-mints ids', async () => {
    const { service, setKind, apply, text } = mountFollow();
    service.enter();
    setKind('pattern');
    service.handleConnectorPick('bolt');

    await apply();
    expect(vi.mocked(api.applyCopy).mock.calls.filter(([options]) => !options.preview)).toEqual([]);
    expect(text('message')).toBe(
      'Pick the repeat to follow — its row in the timeline, or a feature it repeated in the viewport.',
    );

    service.handleTimelinePick(followRowOf('holes'));
    service.update(followScene('-r2'));
    await apply();
    const applied = vi.mocked(api.applyCopy).mock.calls.find(([options]) => !options.preview)![0];
    expect(applied).toMatchObject({ kind: 'pattern', pattern: at(8, 16), targets: [{ kind: 'connector', ...at(12, 15) }] });
  });

  it("ghosts the copies from the repeat's own instances, asking with the repeat's call site", async () => {
    vi.mocked(api.fetchFeatureGhostResult).mockResolvedValue({ solids: [], frames: [FRAME, FRAME, FRAME], notice: null });
    const { service, setKind, ghostGroup } = mountFollow();
    service.enter();
    setKind('pattern');
    service.handleConnectorPick('bolt');
    await vi.advanceTimersByTimeAsync(300);
    // No repeat yet — nothing to ask for.
    expect(vi.mocked(api.fetchFeatureGhostResult)).not.toHaveBeenCalled();

    service.handleTimelinePick(followRowOf('holes'));
    await vi.advanceTimersByTimeAsync(300);

    const request = vi.mocked(api.fetchFeatureGhostResult).mock.calls.at(-1)![0];
    expect(request).toEqual({
      feature: 'copy',
      kind: 'pattern',
      targets: [{ filePath: FILE, line: 12 }],
      pattern: { filePath: FILE, line: 8 },
      axes: [],
      directions: [],
      centered: false,
      count: null,
      sweep: null,
      skip: [],
    });
    expect(ghostGroup().children).toHaveLength(3);
  });

  it('says why the kernel refuses to follow the picked repeat', async () => {
    const reason = "copy(): a connector can't follow a centered circular repeat yet — drop centered on the repeat; "
      + 'its pattern then starts at the original';
    vi.mocked(api.fetchFeatureGhostResult).mockResolvedValue({ solids: null, frames: [], notice: reason });
    const { service, setKind, text } = mountFollow();
    service.enter();
    setKind('pattern');
    service.handleConnectorPick('bolt');
    service.handleTimelinePick(followRowOf('holes'));

    await vi.advanceTimersByTimeAsync(300);

    expect(text('message')).toBe(reason);
  });

  it('reopens a copy that follows a repeat on "Along a repeat", its repeat and connectors kept', async () => {
    const { service, kindSelect, text, hidden, apply } = mountFollow();
    const parsed: Extract<ParsedFeatureStatement, { feature: 'copy' }> = {
      feature: 'copy', kind: 'pattern', patternText: 'holes', patternRef: { line: 8, column: 16 },
      axisTexts: [], axisRefs: [], directions: null, spacingMode: null, centered: false,
      count: null, sweep: null, center: null, skip: null,
      targetTexts: ['bolt'], targetRefs: [{ line: 12, column: 15 }],
    };
    const target = at(14, 2);
    service.enterEdit(target, parsed, { index: 11, type: 'copy-pattern', expectedStatement: 'copy(holes, bolt)' });

    expect(kindSelect().value).toBe('pattern');
    expect(hidden('count-row')).toBe(true);
    expect(text('pattern-slot')).toContain('Current: holes');
    expect(text('targets-slot')).toContain('Current: bolt');

    // At the rolled-back boundary the keeps become their statements' options.
    const scene = [
      ...followScene(),
      {
        id: 'copy', type: 'copy-pattern', name: 'Copy', parentId: 'part', visible: true, ownShapes: [], sceneShapes: [],
        hideChildren: true, sourceLocation: target,
      } as SceneObjectRender,
    ];
    service.handleSceneRendered(scene, 10, true);
    await vi.runAllTimersAsync();
    expect(text('pattern-slot')).toContain('holes');
    expect(text('pattern-slot')).not.toContain('Current');

    await apply();
    const [edit, options] = vi.mocked(api.applyCopyEdit).mock.calls.find(([, o]) => !o.preview)!;
    expect(edit).toEqual(target);
    expect(options).toMatchObject({
      kind: 'pattern',
      pattern: { kind: 'repeat', ...at(8, 16) },
      targets: [{ kind: 'connector', ...at(12, 15) }],
      expectedStatement: 'copy(holes, bolt)',
    });
  });

  it('keeps the repeat as written when the edit never reached its boundary', async () => {
    const { service, apply } = mountFollow();
    service.enterEdit(at(14, 2), {
      feature: 'copy', kind: 'pattern', patternText: 'holes', patternRef: null,
      axisTexts: [], axisRefs: [], directions: null, spacingMode: null, centered: false,
      count: null, sweep: null, center: null, skip: null,
      targetTexts: ['bolt'], targetRefs: [null],
    }, { index: 11, type: 'copy-pattern', expectedStatement: 'copy(holes, bolt)' });

    await apply();
    const [, options] = vi.mocked(api.applyCopyEdit).mock.calls.find(([, o]) => !o.preview)!;
    expect(options).toMatchObject({
      kind: 'pattern', pattern: { kind: 'keep' }, targets: [{ kind: 'verbatim', sourceIndex: 0 }],
    });
  });
});
