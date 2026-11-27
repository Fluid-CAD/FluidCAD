// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PerspectiveCamera, Scene } from 'three';
import { setActivePartProvider, type FeatureEditTarget, type SelectionGroup } from '../src/api';
import { FeatureGhostOverlay } from '../src/interactive/create-feature/feature-ghost';
import { DISTANCE_HINT } from '../src/interactive/create-feature/offset-curve-panel';
import { OffsetCurveFeatureService } from '../src/interactive/create-feature/offset-curve-service';
import { ToolMenu } from '../src/interactive/create-feature/tool-menu';
import { FeatureDialogRegistry, type ParsedFeatureOf } from '../src/interactive/feature-dialog-registry';
import { PartFeatureDialogs, type PartDialogServices } from '../src/interactive/part-feature-dialogs';
import { Navbar } from '../src/ui/navbar';
import { toolIndex } from '../src/ui/quick-find/tool-index';
import { TOOLBAR_BTN_ACTIVE, TOOLBAR_BTN_BASE } from '../src/ui/toolbar-styles';
import type { SceneObjectRender, SubSelection } from '../src/types';
import type { SelectedEntity, Viewer } from '../src/viewer';
import { FakeSelectionServer } from './fixtures/fake-selection-server';

// The Offset dialog of the Curves menu: `offset(distance, edges, { on })`
// outside a sketch, a curve beside edges at a constant distance, lying on
// faces. A curve row (Edges) takes edges of bodies and sketches and curves
// whole; a surface row (On faces) takes faces of bodies and surfaces whole;
// the Distance field takes a length or an expression, its sign the side.
// Edges opens armed and its first pick hands the border to an empty On
// faces. The curve previews as a wire once both rows hold a pick and the
// distance reads, and the engine's refusal reads in the dialog. A timeline
// double-click on an offset-curve row reopens it on the statement's own rows
// and distance, and Apply sends only what changed. The sketch tool's and the
// face Offset's `offset` rows are not its own. The dialog talks to a stubbed
// network (FakeSelectionServer): the shared worker would bind it to another
// test file's api mock.

// The toolbar measures itself with a ResizeObserver, which jsdom lacks.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof ResizeObserver === 'undefined') {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub;
}

let server: FakeSelectionServer;
const menus: ToolMenu[] = [];
const services: OffsetCurveFeatureService[] = [];
const unregister: (() => void)[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  server = new FakeSelectionServer().install();
});

/** Close every dialog and menu a test mounted and empty the page, so a second mount is the one the queries find. */
function unmount(): void {
  for (const service of services.splice(0)) {
    service.exit();
  }
  for (const menu of menus.splice(0)) {
    menu.close();
  }
  document.body.innerHTML = '';
}

afterEach(() => {
  unmount();
  for (const off of unregister.splice(0)) {
    off();
  }
  setActivePartProvider(() => null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

const FILE = '/ws/rim.part.js';
const at = (line: number, column = 0) => ({ filePath: FILE, line, column });
const MESH = [{ vertices: [0, 0, 0, 1, 0, 0], normals: [], indices: [0, 1] }];
const face = (index: number, shapeId = 'box-solid'): SelectedEntity => ({ shapeId, sub: { type: 'face', index } });
const edge = (index: number, shapeId = 'box-solid'): SelectedEntity => ({ shapeId, sub: { type: 'edge', index } });

/** A sketch with a drawn ring, a box, a loaded surface, a projected curve and, with `withCurve`, the offset an edit opens over. */
function scene(withCurve = false): SceneObjectRender[] {
  return [
    {
      id: 'sk', type: 'sketch', name: 'Sketch 1', isContainer: true, ownShapes: [], sceneShapes: [], sourceLocation: at(2),
    },
    {
      id: 'ring', type: 'circle', parentId: 'sk', ownShapes: [], sourceLocation: at(3),
      sceneShapes: [{ shapeId: 'ring-wire', shapeType: 'edge', meshes: MESH }],
    },
    {
      id: 'box', type: 'extrude', name: 'Extrude 1', ownShapes: [], sourceLocation: at(5),
      sceneShapes: [{ shapeId: 'box-solid', shapeType: 'solid', meshes: MESH }],
    },
    {
      id: 'wing', type: 'load', name: 'Load 1', ownShapes: [], sourceLocation: at(6),
      sceneShapes: [{ shapeId: 'wing-surface', shapeType: 'surface', meshes: MESH }],
    },
    {
      id: 'pc', type: 'projected-curve', name: 'Projected Curve 1', ownShapes: [], sourceLocation: at(7),
      sceneShapes: [{ shapeId: 'pc-wire', shapeType: 'wire', meshes: MESH }],
    },
    ...(withCurve ? [{
      id: 'oc', type: 'offset-curve', name: 'Offset Curve 1', ownShapes: [], sourceLocation: at(9),
      sceneShapes: [{ shapeId: 'oc-wire', shapeType: 'wire', meshes: MESH }],
    }] : []),
  ] as unknown as SceneObjectRender[];
}
const rowOf = (id: string) => scene(true).find(o => o.id === id)!;

/** A part holding no body: a sketch alone. */
function bodilessScene(): SceneObjectRender[] {
  return scene().filter(o => o.id === 'sk' || o.id === 'ring');
}

/** A viewer that records the highlight and the pick channels; every other call is a no-op. */
function stubViewer() {
  const highlights: { entities: SelectedEntity[]; wireIds: string[]; shapeIds: string[]; planeQuadIds: string[] }[] = [];
  const base: Record<string, unknown> = {
    pickFilter: 'all',
    pickSketchWires: false,
    pickAxes: false,
    pickPlanes: false,
    pickVertices: false,
    sceneIsEmpty: false,
    missedSketchRender: false,
    isRegionPicking: false,
    sceneContext: { scene: new Scene(), camera: new PerspectiveCamera(), requestRender: () => {} },
    highlightEntities: (entities: SelectedEntity[], wireIds: string[] = [], shapeIds: string[] = [], planeQuadIds: string[] = []) =>
      highlights.push({ entities, wireIds, shapeIds, planeQuadIds }),
    clearHighlight: () => highlights.push({ entities: [], wireIds: [], shapeIds: [], planeQuadIds: [] }),
  };
  const viewer = new Proxy(base, {
    get: (target, key) => (key in target ? target[key as string] : () => {}),
    set: (target, key, value) => {
      target[key as string] = value;
      return true;
    },
  }) as unknown as Viewer;
  return { viewer, highlights, channels: base };
}

/** The bar as main.ts builds it: the Curves menu with Helix, Intersect, Project and Offset, the dialog opened from its cell. */
function mount(objects: SceneObjectRender[] = scene()) {
  unmount();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const navbar = new Navbar(container);
  navbar.addGroup('create', { immune: true });
  navbar.addGroup('transform');
  const curves = new ToolMenu(navbar, {
    group: 'curves',
    before: 'transform',
    label: 'Curves',
    icon: 'curves',
    tip: 'Curve tools',
    tool: 'curves',
    bench: 'Curves',
    quickFindPrefix: 'part',
    emptyText: 'No tools yet',
  });
  menus.push(curves);
  // Added ahead of the others: the menu orders its cells, not their construction.
  const cell = curves.add({
    id: 'offset-curve',
    label: 'Offset',
    iconSrc: 'icons/offset-curve.png',
    tip: 'Offset a curve along faces',
    order: 30,
  });
  curves.add({ id: 'helix', label: 'Helix', iconSrc: 'icons/helix.png', tip: 'Build a helix', order: 0 });
  curves.add({ id: 'projected-curve', label: 'Project', iconSrc: 'icons/projected-curve.png', tip: 'Project', order: 20 });
  curves.add({ id: 'intersection-curve', label: 'Intersect', iconSrc: 'icons/intersection-curve.png', tip: 'Intersect', order: 10 });
  const { viewer, highlights, channels } = stubViewer();
  const service = new OffsetCurveFeatureService(container, viewer, navbar, cell);
  services.push(service);
  service.update(objects);

  const menuButton = container.querySelector<HTMLElement>('[data-tool="curves"] button')!;
  const cellButton = (id = 'offset-curve') => {
    if (!curves.isOpen) {
      menuButton.click();
    }
    return document.querySelector<HTMLButtonElement>(`[data-role="curves-menu"] [data-tool="${id}"] button`)!;
  };
  const panel = () => document.getElementById('fluidcad-offset-curve-panel')!;
  const chips = (row: 'edges' | 'on') =>
    [...panel().querySelectorAll<HTMLElement>(`[data-role="${row}-slot"] span.truncate[title]`)].map(el => el.textContent);
  const message = () => panel().querySelector('[data-role="message"]')!.textContent;
  const armRow = (row: 'edges' | 'on') => panel().querySelector<HTMLElement>(`[data-role="${row}-slot"]`)!.click();
  const distanceInput = () => panel().querySelector<HTMLInputElement>('[data-role="distance"]')!;
  /** Type into the Distance field, as the user does: the text, then the input event. */
  const typeDistance = (text: string) => {
    distanceInput().value = text;
    distanceInput().dispatchEvent(new Event('input', { bubbles: true }));
  };
  const apply = () => panel().querySelector<HTMLButtonElement>('[data-role="apply"]')!.click();
  const click = (entity: SelectedEntity) => service.handleClick(entity.shapeId, entity.sub);
  return {
    container, curves, cell, service, viewer, highlights, channels, menuButton, cellButton, panel, chips, message,
    armRow, distanceInput, typeDistance, apply, click,
  };
}

/** The bodies sent to a route, without the fields the page adds (the active part, the value scope). */
const sent = (route: string) => server.bodies(route).map(({ activePart: _p, valueScope: _s, ...body }) => body);
/** What Apply sent, previews left out. */
const applies = () => sent('api/apply-feature').filter(body => !body.preview);

/** The ghost route's answer: a curve. */
const CURVE = { success: true, solids: [{ kind: 'wire', meshes: [] }] };

/** Open the dialog, pick the box's top rim edge and its side face. */
function pickRows(rig: ReturnType<typeof mount>): void {
  rig.service.enter();
  rig.click(edge(4));
  rig.click(face(2));
}

/** The default rows on both wires. */
const EDGES_EDGE = [{ kind: 'edge', shapeId: 'box-solid', index: 4 }];
const ON_FACE = [{ kind: 'face', shapeId: 'box-solid', index: 2 }];

describe('Offset in the Curves menu', () => {
  it('has a cell after Helix, Intersect and Project that opens the Offset curve dialog and reads as armed while it is open', () => {
    const { curves, cell, service, menuButton, cellButton, panel } = mount();
    menuButton.click();
    expect([...document.querySelectorAll<HTMLElement>('[data-role="curves-menu"] [data-tool]')]
      .map(el => el.dataset.tool)).toEqual(['helix', 'intersection-curve', 'projected-curve', 'offset-curve']);
    expect(cellButton().textContent).toBe('Offset');

    cellButton().click();
    expect(service.isActive).toBe(true);
    expect(curves.isOpen).toBe(false);
    expect(cell.active).toBe(true);
    expect(menuButton.className).toBe(TOOLBAR_BTN_ACTIVE);
    expect(panel().classList.contains('hidden')).toBe(false);
    for (const label of ['Offset curve', 'Edges', 'On faces', 'Distance', DISTANCE_HINT]) {
      expect(panel().textContent).toContain(label);
    }
    expect(DISTANCE_HINT).toContain('negative distance goes to the other side');

    cellButton().click();
    expect(service.isActive).toBe(false);
    expect(menuButton.className).toBe(TOOLBAR_BTN_BASE);
  });

  it('greys its cell until the scene holds a body, a solid or a surface', () => {
    const { service, cell, cellButton } = mount(bodilessScene());
    expect(cell.disabled).toBe(true);
    expect(cellButton().disabled).toBe(true);
    expect(toolIndex.get('part:offset-curve')!.isDisabled!()).toBe(true);
    service.update(scene().filter(o => o.id !== 'box'));
    expect(cellButton().disabled).toBe(false);
    service.update(scene().filter(o => o.id !== 'wing'));
    expect(cellButton().disabled).toBe(false);
  });

  it('is run by Quick Find as part:offset-curve under Curves, and found by offset edge, parallel curve and inset', () => {
    const { service } = mount();
    const entry = toolIndex.get('part:offset-curve')!;
    expect(entry.bench).toBe('Curves');
    expect(entry.tip).toBe('Offset a curve along faces');
    expect(entry.iconSrc).toBe('icons/offset-curve.png');
    for (const word of ['offset edge', 'parallel curve', 'inset']) {
      expect(toolIndex.search(word).map(match => match.tool.id), word).toContain('part:offset-curve');
    }
    entry.run();
    expect(service.isActive).toBe(true);
    expect(entry.isActive!()).toBe(true);
  });

  it('is found by "offset" beside the face Offset outside a sketch, and leaves the sketch\'s Offset alone inside one', () => {
    const { curves } = mount();
    // The face Offset button and the sketch toolbar's Offset tool, as they
    // register themselves: the one hides with the modify tools in a sketch,
    // the other shows only there.
    let sketching = false;
    unregister.push(toolIndex.register({
      id: 'part:offset', label: 'Offset', tip: 'Offset the outlines of the highlighted faces', bench: 'Part',
      iconSrc: 'icons/offset.png', isAvailable: () => !sketching, run: () => {},
    }));
    unregister.push(toolIndex.register({
      id: 'sketch:offset', label: 'Offset', tip: 'Offset', bench: 'Sketch', iconSrc: 'icons/offset.png',
      keywords: ['parallel', 'inset', 'outset'], isAvailable: () => sketching, run: () => {},
    }));
    const found = (query: string) => toolIndex.search(query).map(match => match.tool.id);
    expect(found('offset')).toEqual(expect.arrayContaining(['part:offset-curve', 'part:offset']));
    expect(found('offset')).not.toContain('sketch:offset');

    // A sketch up: the Curves menu leaves the bar with the other part tools.
    sketching = true;
    curves.setSketchHidden(true);
    expect(found('offset')).toEqual(['sketch:offset']);
    expect(found('inset')).toEqual(['sketch:offset']);
  });
});

describe('the Offset curve dialog', () => {
  it('opens with Edges armed and hands the border to an empty On faces on Edges\' first pick', () => {
    const { service, channels, chips, armRow, click } = mount();
    service.enter();
    const panel = service.dialogPanel;
    expect(panel.armedRow).toBe('edges');
    // A curve row: edges and sketch wires.
    expect(channels).toMatchObject({ pickFilter: 'edge', pickSketchWires: true });

    click(edge(4));
    expect(chips('edges')).toEqual(['Picked edge']);
    expect(panel.armedRow).toBe('on');
    expect(channels).toMatchObject({ pickFilter: 'face', pickSketchWires: false });

    click(face(2));
    expect(chips('on')).toEqual(['Picked face']);
    // On faces holds a pick: it stays armed for more.
    expect(panel.armedRow).toBe('on');
    click(face(3));
    expect(chips('on')).toEqual(['Picked face', 'Picked face']);

    // Back on Edges, On faces holding something: Edges keeps the border.
    armRow('edges');
    click(edge(5));
    expect(chips('edges')).toEqual(['Picked edge', 'Picked edge']);
    expect(panel.armedRow).toBe('edges');
    // Nothing fills On faces from the edges: a pick there is the user's.
    expect(chips('on')).toHaveLength(2);
  });

  it('takes timeline rows into the armed row, refusing a row the row takes nothing from', () => {
    const { service, chips, message } = mount();
    service.enter();
    expect(service.handleTimelinePick(rowOf('box'))).toBe(true);
    expect(message()).toContain('Extrude 1 holds no curve');
    expect(service.handleTimelinePick(rowOf('pc'))).toBe(true);
    expect(chips('edges')).toEqual(['Projected Curve 1']);
    expect(service.handleTimelinePick(rowOf('pc'))).toBe(true);
    expect(message()).toContain('Projected Curve 1 holds no surface');
    expect(service.handleTimelinePick(rowOf('wing'))).toBe(true);
    expect(chips('on')).toEqual(['Load 1']);
  });

  it('previews nothing until both rows hold a pick, then sends the rows with the distance, the curve drawn as a wire', async () => {
    server.routes.set('api/feature-ghost', () => CURVE);
    const set = vi.spyOn(FeatureGhostOverlay.prototype, 'set').mockImplementation(() => {});
    const rig = mount();
    rig.service.enter();
    expect(rig.distanceInput().value).toBe('1');
    rig.click(edge(4));
    await vi.advanceTimersByTimeAsync(300);
    expect(server.count('api/apply-feature')).toBe(0);
    expect(server.count('api/feature-ghost')).toBe(0);

    rig.click(face(2));
    await vi.advanceTimersByTimeAsync(300);
    expect(sent('api/apply-feature')).toEqual([{ feature: 'offset-curve', distance: 1, edges: EDGES_EDGE, on: ON_FACE, preview: true }]);
    expect(sent('api/feature-ghost')).toEqual([{ feature: 'offset-curve', distance: 1, edges: EDGES_EDGE, on: ON_FACE }]);
    expect(set).toHaveBeenLastCalledWith(CURVE.solids, 'wire');

    // The sign is the side: the preview follows the field.
    rig.typeDistance('-3');
    await vi.advanceTimersByTimeAsync(300);
    expect(sent('api/feature-ghost').at(-1)).toMatchObject({ distance: -3 });
  });

  it('previews nothing while the distance does not read or is zero, and Apply says so', async () => {
    server.routes.set('api/feature-ghost', () => CURVE);
    const rig = mount();
    pickRows(rig);
    rig.typeDistance('0');
    await vi.advanceTimersByTimeAsync(300);
    rig.typeDistance('');
    await vi.advanceTimersByTimeAsync(300);
    expect(server.count('api/apply-feature')).toBe(0);
    expect(server.count('api/feature-ghost')).toBe(0);
    rig.apply();
    await vi.advanceTimersByTimeAsync(0);
    expect(rig.message()).toBe('Enter a distance other than zero: a negative one goes to the other side.');

    rig.typeDistance('class = 3');
    rig.apply();
    await vi.advanceTimersByTimeAsync(0);
    expect(rig.message()).toBe("Enter a valid distance — 'class' is not a valid name.");
    expect(applies()).toEqual([]);

    rig.typeDistance('2.5');
    await vi.advanceTimersByTimeAsync(300);
    expect(sent('api/feature-ghost')).toEqual([{ feature: 'offset-curve', distance: 2.5, edges: EDGES_EDGE, on: ON_FACE }]);
  });

  it('reads an expression distance where the statement lands, and writes a new name\'s declaration with it', async () => {
    const PART = { filePath: FILE, line: 1, column: 0 };
    setActivePartProvider(() => PART);
    server.routes.set('api/scope-variables', () => ({ variables: [{ name: 'band', initializer: '4', numeric: true }] }));
    server.routes.set('api/feature-ghost', () => CURVE);
    const rig = mount();
    pickRows(rig);
    expect(server.bodies('api/scope-variables')).toEqual([{ sketchSourceLine: null, part: PART }]);
    await vi.advanceTimersByTimeAsync(0);

    rig.typeDistance('-band');
    await vi.advanceTimersByTimeAsync(300);
    expect(server.bodies('api/feature-ghost').at(-1)).toMatchObject({
      distance: '-band', valueScope: { kind: 'append', ...PART },
    });
    expect(sent('api/apply-feature').at(-1)).toEqual({
      feature: 'offset-curve', distance: '-band', edges: EDGES_EDGE, on: ON_FACE, preview: true,
    });

    rig.typeDistance('inset = 2');
    rig.apply();
    await vi.advanceTimersByTimeAsync(0);
    expect(applies()).toEqual([{
      feature: 'offset-curve',
      distance: 'inset',
      edges: EDGES_EDGE,
      on: ON_FACE,
      newVariables: [{ name: 'inset', initializer: expect.stringContaining('2') }],
    }]);
  });

  it('shows the engine\'s refusal in the dialog', async () => {
    server.routes.set('api/feature-ghost', () => ({
      success: false, reason: 'offset: at this distance the curve leaves the faces.', surface: true,
    }));
    const rig = mount();
    pickRows(rig);
    rig.typeDistance('-3');
    await vi.advanceTimersByTimeAsync(300);
    expect(rig.message()).toBe('offset: at this distance the curve leaves the faces.');
    // A change clears it; the next answer says its own.
    rig.typeDistance('3');
    expect(rig.message()).toBe('');
  });

  it('applies the rows in pick order with the distance, and refuses an Apply with an empty row', async () => {
    const rig = mount();
    rig.service.enter();
    rig.apply();
    await vi.advanceTimersByTimeAsync(0);
    expect(rig.message()).toBe('Pick the edges to offset: edges of a body, curves, or sketches.');
    rig.service.handleSketchPick('ring-wire');
    rig.apply();
    await vi.advanceTimersByTimeAsync(0);
    expect(rig.message()).toBe('Pick the faces the edges lie on: faces of a body, or surfaces.');
    expect(applies()).toEqual([]);

    rig.click(face(2));
    rig.service.handleTimelinePick(rowOf('wing'));
    rig.armRow('edges');
    rig.click(edge(4));
    rig.typeDistance('3');
    rig.apply();
    await vi.advanceTimersByTimeAsync(0);
    expect(applies()).toEqual([{
      feature: 'offset-curve',
      distance: 3,
      edges: [{ kind: 'statement', ...at(2) }, ...EDGES_EDGE],
      on: [...ON_FACE, { kind: 'statement', ...at(6) }],
    }]);
    expect(rig.service.isActive).toBe(false);
  });

  it('grows Edges by a double-clicked rim\'s loop, never filling On faces with its second click', async () => {
    server.loop = () => ({ rim: true, members: [edge(4), edge(5), edge(6), edge(7)] });
    const { service, chips, click } = mount();
    service.enter();
    // The viewer's double-click: its two clicks land first. The first takes
    // the edge into Edges and arms On faces, which picks faces: the second
    // takes the face behind the edge into On faces.
    click(edge(4));
    click(face(2));
    expect(chips('on')).toEqual(['Picked face']);
    await service.handleDoubleClick('box-solid', face(2).sub);
    expect(chips('edges')).toHaveLength(4);
    expect(chips('on')).toEqual([]);
    expect(service.dialogPanel.armedRow).toBe('on');
    expect(server.bodies('api/selection/expand-loop').map(body => body.entity)).toEqual([edge(4)]);
  });

  it('lands a right-click group in the armed row as plain picks', async () => {
    server.groups = [{ kind: 'loop', label: 'Side Faces', members: [face(1), face(2), face(3), face(4)] }] as SelectionGroup[];
    const { container, service, chips, click } = mount();
    service.enter();
    click(edge(4));
    service.handleContextMenu('box-solid', face(2).sub, 10, 10);
    await vi.advanceTimersByTimeAsync(0);
    const items = [...container.querySelectorAll<HTMLButtonElement>('#fluidcad-offset-curve-select-menu button')];
    expect(items.map(item => item.textContent)).toEqual(['Side Faces (4)']);
    items[0].click();
    expect(chips('on')).toHaveLength(4);
    expect(chips('edges')).toEqual(['Picked edge']);
  });
});

describe('editing an offset curve', () => {
  const TARGET: FeatureEditTarget = at(9);
  const PARSED = {
    feature: 'offset-curve',
    distance: 3,
    distanceArg: '3',
    edgesTexts: ['box.endEdges()'],
    edgesRefs: [null],
    edgesArg: 'box.endEdges()',
    onTexts: ['box.sideFaces()'],
    onRefs: [null],
    onArg: 'box.sideFaces()',
  } as ParsedFeatureOf<'offset-curve'>;
  // The curve is the scene's sixth row: the session rolls back to just before it.
  const INFO = { index: 5, type: 'offset-curve', expectedStatement: "offset(3, box.endEdges(), { on: box.sideFaces() }).name('Offset Curve 1')" };
  const BOUNDARY = { index: 5, type: 'offset-curve', line: 9, column: 0 };
  const EDIT = { feature: 'offset-curve', edit: TARGET, expectedStatement: INFO.expectedStatement };

  /** Open the dialog over the curve, the engine resolving both rows, and land at the boundary. */
  async function openEdit(parsed: Partial<typeof PARSED> = {}) {
    server.routes.set('api/feature/sources', () => ({
      ok: true,
      feature: 'offset-curve',
      edges: [{ kind: 'entities', entities: [edge(4), edge(5)] }],
      on: [{ kind: 'entities', entities: [face(1), face(3)] }],
    }));
    server.routes.set('api/feature-ghost', () => CURVE);
    const rig = mount(scene(true));
    rig.service.enterEdit(TARGET, { ...PARSED, ...parsed }, INFO);
    await vi.advanceTimersByTimeAsync(0);
    rig.service.handleSceneRendered(scene(true), 4, true);
    await vi.advanceTimersByTimeAsync(300);
    return rig;
  }

  it('reopens on both rows as Current chips lit as the engine resolved them, and the distance as written', async () => {
    const { panel, chips, distanceInput, highlights } = await openEdit();
    expect(panel().textContent).toContain('Edit offset curve');
    expect(chips('edges')).toEqual(['Current: box.endEdges()']);
    expect(chips('on')).toEqual(['Current: box.sideFaces()']);
    expect(distanceInput().value).toBe('3');
    expect(server.bodies('api/feature/sources')).toEqual([{ before: BOUNDARY }]);
    expect(server.bodies('api/scope-variables').at(-1)).toEqual({ sketchSourceLine: 9 });
    expect(highlights.at(-1)).toMatchObject({ entities: [edge(4), edge(5), face(1), face(3)] });
    expect(server.bodies('api/feature-ghost').at(-1)).toEqual({
      feature: 'offset-curve',
      distance: 3,
      edges: [4, 5].map(index => ({ kind: 'edge', shapeId: 'box-solid', index })),
      on: [1, 3].map(index => ({ kind: 'face', shapeId: 'box-solid', index })),
      valueScope: { kind: 'statement', ...TARGET },
    });
  });

  it('applies an untouched edit with nothing but the statement', async () => {
    const { service, apply } = await openEdit();
    apply();
    await vi.advanceTimersByTimeAsync(0);
    expect(applies()).toEqual([EDIT]);
    expect(service.isActive).toBe(false);
  });

  it('sends only the distance when only the distance changed, both rows written back as they were', async () => {
    const rig = await openEdit();
    rig.typeDistance('-3');
    await vi.advanceTimersByTimeAsync(300);
    expect(sent('api/apply-feature').at(-1)).toEqual({ ...EDIT, distance: -3, preview: true });
    expect(sent('api/feature-ghost').at(-1)).toMatchObject({ distance: -3 });
    rig.apply();
    await vi.advanceTimersByTimeAsync(0);
    expect(applies().at(-1)).toEqual({ ...EDIT, distance: -3 });
  });

  it('keeps an expression distance as written, and sends a new one with the declaration it commits', async () => {
    const kept = await openEdit({ distance: 'band / 2', distanceArg: 'band / 2' });
    expect(kept.distanceInput().value).toBe('band / 2');
    expect(sent('api/feature-ghost').at(-1)).toMatchObject({ distance: 'band / 2' });
    kept.apply();
    await vi.advanceTimersByTimeAsync(0);
    expect(applies().at(-1)).toEqual(EDIT);

    const declared = await openEdit();
    declared.typeDistance('rim = 4');
    declared.apply();
    await vi.advanceTimersByTimeAsync(0);
    expect(applies().at(-1)).toEqual({
      ...EDIT, distance: 'rim', newVariables: [{ name: 'rim', initializer: expect.stringContaining('4') }],
    });
  });

  it('rewrites only the re-picked row: edges with the boundary, a surface without, the distance kept', async () => {
    const rig = await openEdit();
    // The statement's edges all resolved: a pick adds to them.
    rig.click(edge(6));
    expect(rig.chips('edges')).toEqual(['Picked edge', 'Picked edge', 'Picked edge']);
    rig.apply();
    await vi.advanceTimersByTimeAsync(0);
    expect(applies().at(-1)).toEqual({
      ...EDIT,
      before: BOUNDARY,
      edges: [4, 5, 6].map(index => ({ kind: 'edge', shapeId: 'box-solid', index })),
    });

    const surface = await openEdit();
    surface.armRow('on');
    surface.service.handleTimelinePick(rowOf('pc'));
    expect(surface.message()).toContain('holds no surface');
    surface.service.handleTimelinePick(rowOf('wing'));
    // A list whose kept faces resolved starts from them: taken back out, the surface alone stays.
    surface.click(face(1));
    surface.click(face(3));
    expect(surface.chips('on')).toEqual(['Load 1']);
    surface.apply();
    await vi.advanceTimersByTimeAsync(0);
    expect(applies().at(-1)).toEqual({ ...EDIT, on: [{ kind: 'statement', ...at(6) }] });

    const both = await openEdit();
    both.armRow('on');
    both.click(face(2));
    both.typeDistance('5');
    both.apply();
    await vi.advanceTimersByTimeAsync(0);
    expect(applies().at(-1)).toEqual({
      ...EDIT,
      before: BOUNDARY,
      distance: 5,
      on: [1, 3, 2].map(index => ({ kind: 'face', shapeId: 'box-solid', index })),
    });
  });

  it('opens from an offset-curve row through the registry, where the sketch tool\'s and the face Offset\'s offset rows find no dialog', async () => {
    server.routes.set('api/feature/sources', () => ({ ok: true, feature: 'offset-curve', edges: [], on: [] }));
    const rig = mount(scene(true));
    const registry = new FeatureDialogRegistry();
    // Every other dialog a stand-in that is never open: only the routing is read.
    const idle = { isActive: false, isEditing: false, isPicking: false, sketchUISuspended: false, exit: () => {}, handleSceneRendered: () => {} };
    const others = new Proxy({} as Record<string, unknown>, { get: (_target, key) => key === 'offsetCurve' ? rig.service : idle });
    PartFeatureDialogs.register(registry, others as unknown as PartDialogServices);

    expect(registry.editsRowType('offset-curve')).toBe(true);
    expect(registry.editsRowType('offset')).toBe(false);
    expect(registry.forStatement({ feature: 'offset' } as ParsedFeatureOf<'offset'>)).toBeNull();
    const dialog = registry.forStatement(PARSED)!;
    expect(dialog.id).toBe('offset-curve');
    dialog.enterEdit!(TARGET, PARSED, INFO, rowOf('oc'));
    expect(rig.service.isEditing).toBe(true);
    expect(rig.chips('edges')).toEqual(['Current: box.endEdges()']);
  });
});
