// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PerspectiveCamera, Scene } from 'three';
import type { FeatureEditTarget, ParsedFeatureStatement, SelectionGroup } from '../src/api';
import { FeatureGhostOverlay } from '../src/interactive/create-feature/feature-ghost';
import { DIRECTION_HINT } from '../src/interactive/create-feature/projected-curve-panel';
import { ProjectedCurveFeatureService } from '../src/interactive/create-feature/projected-curve-service';
import { ToolMenu } from '../src/interactive/create-feature/tool-menu';
import { Navbar } from '../src/ui/navbar';
import { toolIndex } from '../src/ui/quick-find/tool-index';
import { TOOLBAR_BTN_ACTIVE, TOOLBAR_BTN_BASE } from '../src/ui/toolbar-styles';
import type { SceneObjectRender, SubSelection } from '../src/types';
import type { SelectedEntity, Viewer } from '../src/viewer';
import { FakeSelectionServer } from './fixtures/fake-selection-server';

// The Project dialog of the Curves menu: `project(source, target)` outside a
// sketch, curves thrown onto faces. A curve row (Curves) takes sketches and
// curves whole and edges of bodies; a surface row (Onto) takes surfaces
// whole and faces of bodies; the mode and Keep are two button rows; the
// Direction row, shown only for "Along direction", takes a line — empty, the
// normal of the plane the curves lie in. Curves opens armed and its first
// pick hands the border to an empty Onto; Direction is armed by a click. The
// curve previews as a wire once both operand rows hold a pick, and the
// engine's refusal reads in the dialog. A timeline double-click reopens it on
// the statement's own arguments, mode, direction and Keep, and Apply sends
// only what changed. The dialog talks to a stubbed network
// (FakeSelectionServer): the shared worker would bind it to another test
// file's api mock.

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
const services: ProjectedCurveFeatureService[] = [];
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

const FILE = '/ws/dome.part.js';
const at = (line: number, column = 0) => ({ filePath: FILE, line, column });
const MESH = [{ vertices: [0, 0, 0, 1, 0, 0], normals: [], indices: [0, 1] }];
const face = (index: number, shapeId = 'dome-solid'): SelectedEntity => ({ shapeId, sub: { type: 'face', index } });
const edge = (index: number, shapeId = 'dome-solid'): SelectedEntity => ({ shapeId, sub: { type: 'edge', index } });
const SKETCH_WIRE: SubSelection = { type: 'sketch', index: 0 };

/** A sketch with a drawn ring, a dome, a loaded surface, an axis and a plane, and with `withCurve` the curve an edit opens over. */
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
      id: 'dome', type: 'revolve', name: 'Revolve 1', ownShapes: [], sourceLocation: at(5),
      sceneShapes: [{ shapeId: 'dome-solid', shapeType: 'solid', meshes: MESH }],
    },
    {
      id: 'wing', type: 'load', name: 'Load 1', ownShapes: [], sourceLocation: at(6),
      sceneShapes: [{ shapeId: 'wing-surface', shapeType: 'surface', meshes: MESH }],
    },
    {
      id: 'ax', type: 'axis', name: 'Axis 1', ownShapes: [], sourceLocation: at(7),
      sceneShapes: [{ shapeId: 'axis-line', shapeType: 'edge', isMetaShape: true, meshes: MESH }],
    },
    {
      id: 'pl', type: 'plane', name: 'Plane 1', ownShapes: [], sourceLocation: at(8),
      sceneShapes: [{ shapeId: 'plane-quad', shapeType: 'face', isMetaShape: true, meshes: MESH }],
    },
    ...(withCurve ? [{
      id: 'pc', type: 'projected-curve', name: 'Projected Curve 1', ownShapes: [], sourceLocation: at(10),
      sceneShapes: [{ shapeId: 'pc-wire', shapeType: 'wire', meshes: MESH }],
    }] : []),
  ] as unknown as SceneObjectRender[];
}

/** A part holding no body to project onto: a sketch and a plane. */
function bodilessScene(): SceneObjectRender[] {
  return scene().filter(o => o.id !== 'dome' && o.id !== 'wing');
}

/** A viewer that records the highlight and the standard datums it is told to show; every other call is a no-op. */
function stubViewer() {
  const highlights: { entities: SelectedEntity[]; wireIds: string[]; shapeIds: string[]; planeQuadIds: string[] }[] = [];
  const shown = { axes: false, planes: false, onPick: null as null | ((name: string) => void) };
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
    showStandardAxes: (onPick: (name: string) => void) => {
      shown.axes = true;
      shown.onPick = onPick;
    },
    hideStandardAxes: () => {
      shown.axes = false;
    },
    showStandardPlanes: (onPick: (name: string) => void) => {
      shown.planes = true;
      shown.onPick = onPick;
    },
    hideStandardPlanes: () => {
      shown.planes = false;
    },
  };
  const viewer = new Proxy(base, {
    get: (target, key) => (key in target ? target[key as string] : () => {}),
    set: (target, key, value) => {
      target[key as string] = value;
      return true;
    },
  }) as unknown as Viewer;
  return { viewer, highlights, channels: base, shown };
}

/** The bar as main.ts builds it: the Curves menu with Helix, Intersect and Project, the dialog opened from its cell. */
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
  curves.add({ id: 'helix', label: 'Helix', iconSrc: 'icons/helix.png', tip: 'Build a helix', order: 0 });
  // Added ahead of Intersect: the menu orders its cells, not their construction.
  const cell = curves.add({
    id: 'projected-curve',
    label: 'Project',
    iconSrc: 'icons/projected-curve.png',
    tip: 'Project a curve onto faces',
    order: 20,
  });
  curves.add({ id: 'intersection-curve', label: 'Intersect', iconSrc: 'icons/intersection-curve.png', tip: 'Intersect', order: 10 });
  const { viewer, highlights, channels, shown } = stubViewer();
  const service = new ProjectedCurveFeatureService(container, viewer, navbar, cell);
  services.push(service);
  service.update(objects);

  const menuButton = container.querySelector<HTMLElement>('[data-tool="curves"] button')!;
  const cellButton = (id = 'projected-curve') => {
    if (!curves.isOpen) {
      menuButton.click();
    }
    return document.querySelector<HTMLButtonElement>(`[data-role="curves-menu"] [data-tool="${id}"] button`)!;
  };
  const panel = () => document.getElementById('fluidcad-projected-curve-panel')!;
  const chips = (row: 'source' | 'target' | 'direction') =>
    [...panel().querySelectorAll<HTMLElement>(`[data-role="${row}-slot"] span.truncate[title]`)].map(el => el.textContent);
  const message = () => panel().querySelector('[data-role="message"]')!.textContent;
  const armRow = (row: 'source' | 'target' | 'direction') => panel().querySelector<HTMLElement>(`[data-role="${row}-slot"]`)!.click();
  const tab = (row: 'mode' | 'keep', label: string) =>
    [...panel().querySelectorAll<HTMLButtonElement>(`[data-role="${row}-tabs"] button`)].find(b => b.textContent === label)!;
  const activeTab = (row: 'mode' | 'keep') =>
    [...panel().querySelectorAll<HTMLButtonElement>(`[data-role="${row}-tabs"] button`)].find(b => b.className.includes('btn-primary'))!.textContent;
  const directionShown = () => !panel().querySelector('[data-role="direction-group"]')!.classList.contains('hidden');
  const removeDirection = () => [...panel().querySelectorAll<HTMLButtonElement>('[data-role="direction-slot"] button')]
    .find(b => b.textContent === '✕')!.click();
  const apply = () => panel().querySelector<HTMLButtonElement>('[data-role="apply"]')!.click();
  const click = (entity: SelectedEntity) => service.handleClick(entity.shapeId, entity.sub);
  return {
    container, curves, cell, service, viewer, highlights, channels, shown, menuButton, cellButton, panel, chips, message,
    armRow, tab, activeTab, directionShown, removeDirection, apply, click,
  };
}

/** The last bodies sent to a route, without the fields the page adds (the active part, the value scope). */
const sent = (route: string) => server.bodies(route).map(({ activePart: _p, valueScope: _s, ...body }) => body);

/** The ghost route's answer: a curve. */
const CURVE = { success: true, solids: [{ kind: 'wire', meshes: [] }] };

/** The engine says every edge is straight, every face planar. */
function straightAndFlat(): void {
  server.routes.set('api/edge-properties', () => ({ curveType: 'line' }));
  server.routes.set('api/face-properties', () => ({ surfaceType: 'plane' }));
}

/** Open the dialog, pick the sketch and the dome's top face. */
function pickRows(rig: ReturnType<typeof mount>): void {
  rig.service.enter();
  rig.service.handleSketchPick('ring-wire');
  rig.click(face(3));
}

/** The default rows on both wires. */
const SOURCE_SKETCH = [{ kind: 'statement', ...at(2) }];
const TARGET_FACE = [{ kind: 'face', shapeId: 'dome-solid', index: 3 }];
const GHOST_SOURCE_SKETCH = [{ kind: 'statement', filePath: FILE, line: 2 }];

describe('Project in the Curves menu', () => {
  it('has a cell after Helix and Intersect that opens the dialog and reads as armed while it is open', () => {
    const { curves, cell, service, menuButton, cellButton, panel } = mount();
    menuButton.click();
    expect([...document.querySelectorAll<HTMLElement>('[data-role="curves-menu"] [data-tool]')]
      .map(el => el.dataset.tool)).toEqual(['helix', 'intersection-curve', 'projected-curve']);
    expect(cellButton().textContent).toBe('Project');

    cellButton().click();
    expect(service.isActive).toBe(true);
    expect(curves.isOpen).toBe(false);
    expect(cell.active).toBe(true);
    expect(menuButton.className).toBe(TOOLBAR_BTN_ACTIVE);
    expect(panel().classList.contains('hidden')).toBe(false);
    for (const label of ['Curves', 'Onto', 'Mode', 'Direction', 'Keep', 'Along direction', 'Normal to surface', 'Nearest', 'All']) {
      expect(panel().textContent).toContain(label);
    }

    cellButton().click();
    expect(service.isActive).toBe(false);
    expect(menuButton.className).toBe(TOOLBAR_BTN_BASE);
  });

  it('greys its cell until the scene holds a body to project onto, a solid or a surface', () => {
    const { service, cell, cellButton } = mount(bodilessScene());
    expect(cell.disabled).toBe(true);
    expect(cellButton().disabled).toBe(true);
    expect(toolIndex.get('part:projected-curve')!.isDisabled!()).toBe(true);
    service.update(scene().filter(o => o.id !== 'dome'));
    expect(cellButton().disabled).toBe(false);
    service.update(scene().filter(o => o.id !== 'wing'));
    expect(cellButton().disabled).toBe(false);
  });

  it('is run by Quick Find as part:projected-curve under Curves, and found by project, drop curve, imprint and curve on surface', () => {
    const { service } = mount();
    const entry = toolIndex.get('part:projected-curve')!;
    expect(entry.bench).toBe('Curves');
    expect(entry.tip).toBe('Project a curve onto faces');
    expect(entry.iconSrc).toBe('icons/projected-curve.png');
    for (const word of ['project', 'drop curve', 'imprint', 'curve on surface']) {
      expect(toolIndex.search(word).map(match => match.tool.id), word).toContain('part:projected-curve');
    }
    entry.run();
    expect(service.isActive).toBe(true);
    expect(entry.isActive!()).toBe(true);
  });

  it('leaves the sketch\'s own Project tool what Quick Find finds inside a sketch', () => {
    const { curves } = mount();
    // The sketch toolbar's Project tool, as it registers itself: shown only in a sketch.
    let sketching = false;
    unregister.push(toolIndex.register({
      id: 'sketch:project', label: 'Project', tip: 'Project', bench: 'Sketch', iconSrc: 'icons/projection.png',
      isAvailable: () => sketching, run: () => {},
    }));
    expect(toolIndex.search('project')[0].tool.id).toBe('part:projected-curve');

    // A sketch up: the Curves menu leaves the bar with the other part tools.
    sketching = true;
    curves.setSketchHidden(true);
    const found = toolIndex.search('project').map(match => match.tool.id);
    expect(found[0]).toBe('sketch:project');
    expect(found).not.toContain('part:projected-curve');
  });
});

describe('the Project dialog', () => {
  it('opens with Curves armed, hands the border to an empty Onto on Curves\' first pick, and arms Direction only when clicked', () => {
    const { service, channels, shown, chips, armRow, click } = mount();
    service.enter();
    const panel = service.dialogPanel;
    expect(panel.armedRow).toBe('source');
    // A curve row: edges and sketch wires.
    expect(channels).toMatchObject({ pickFilter: 'edge', pickSketchWires: true, pickAxes: false });
    expect(shown.axes).toBe(false);

    expect(service.handleSketchPick('ring-wire')).toBe(true);
    expect(chips('source')).toEqual(['Sketch']);
    expect(panel.armedRow).toBe('target');
    expect(channels).toMatchObject({ pickFilter: 'face', pickSketchWires: false });

    click(face(3));
    expect(chips('target')).toEqual(['Picked face']);
    // An Onto that holds a pick stays armed for more; Direction waits for a click.
    expect(panel.armedRow).toBe('target');

    armRow('direction');
    expect(panel.armedRow).toBe('direction');
    expect(channels).toMatchObject({ pickFilter: 'all', pickAxes: true, pickPlanes: true });
    expect(shown).toMatchObject({ axes: true, planes: true });

    // Back on Curves, Onto holding something: Curves keeps the border.
    armRow('source');
    expect(shown).toMatchObject({ axes: false, planes: false });
    click(edge(4));
    expect(chips('source')).toEqual(['Sketch', 'Picked edge']);
    expect(panel.armedRow).toBe('source');
  });

  it('takes timeline rows into the armed row, refusing a row the row takes nothing from', () => {
    const { service, chips, message } = mount();
    service.enter();
    expect(service.handleTimelinePick(scene()[2])).toBe(true);
    expect(message()).toContain('Revolve 1 holds no curve');
    expect(service.handleTimelinePick(scene()[0])).toBe(true);
    expect(chips('source')).toEqual(['Sketch']);
    expect(service.handleTimelinePick(scene()[3])).toBe(true);
    expect(chips('target')).toEqual(['Load 1']);

    service.dialogPanel.armRow('direction');
    expect(service.handleTimelinePick(scene()[2])).toBe(true);
    expect(message()).toContain('Revolve 1 gives no direction');
    expect(service.handleTimelinePick(scene()[4])).toBe(true);
    expect(chips('direction')).toEqual(['Axis']);
  });

  it('previews nothing until both rows hold a pick, then sends the rows with the defaults, the curve drawn as a wire', async () => {
    server.routes.set('api/feature-ghost', () => CURVE);
    const set = vi.spyOn(FeatureGhostOverlay.prototype, 'set').mockImplementation(() => {});
    const rig = mount();
    rig.service.enter();
    rig.service.handleSketchPick('ring-wire');
    await vi.advanceTimersByTimeAsync(300);
    expect(server.count('api/apply-feature')).toBe(0);
    expect(server.count('api/feature-ghost')).toBe(0);

    rig.click(face(3));
    await vi.advanceTimersByTimeAsync(300);
    expect(sent('api/apply-feature')).toEqual([{
      feature: 'projected-curve',
      source: SOURCE_SKETCH,
      target: TARGET_FACE,
      mode: 'direction',
      direction: null,
      keep: 'nearest',
      preview: true,
    }]);
    expect(sent('api/feature-ghost')).toEqual([{
      feature: 'projected-curve',
      source: GHOST_SOURCE_SKETCH,
      target: TARGET_FACE,
      mode: 'direction',
      direction: null,
      keep: 'nearest',
    }]);
    expect(set).toHaveBeenLastCalledWith(CURVE.solids, 'wire');
  });

  it('says what an empty Direction stands for, and follows a world axis, an edge, a planar face, a plane and Keep', async () => {
    server.routes.set('api/feature-ghost', () => CURVE);
    straightAndFlat();
    const rig = mount();
    pickRows(rig);
    expect(rig.panel().querySelector('[data-role="direction-slot"]')!.textContent).toContain(DIRECTION_HINT);
    rig.armRow('direction');
    const lastGhost = async () => {
      await vi.advanceTimersByTimeAsync(300);
      return sent('api/feature-ghost').at(-1);
    };

    rig.shown.onPick!('z');
    expect(rig.chips('direction')).toEqual(['World Z axis']);
    expect(await lastGhost()).toMatchObject({ direction: { kind: 'standard', axis: 'z' } });

    rig.click(edge(2));
    await vi.advanceTimersByTimeAsync(0);
    expect(rig.chips('direction')).toEqual(['Picked edge']);
    expect(await lastGhost()).toMatchObject({ direction: { kind: 'edge', shapeId: 'dome-solid', index: 2 } });
    expect(rig.highlights.at(-1)!.entities).toContainEqual(edge(2));

    rig.click(face(0));
    await vi.advanceTimersByTimeAsync(0);
    expect(await lastGhost()).toMatchObject({ direction: { kind: 'face', shapeId: 'dome-solid', index: 0 } });

    rig.service.handlePlanePick('plane-quad');
    expect(rig.chips('direction')).toEqual(['Plane']);
    expect(await lastGhost()).toMatchObject({ direction: { kind: 'plane', filePath: FILE, line: 8 } });
    expect(sent('api/apply-feature').at(-1)).toMatchObject({ direction: { kind: 'plane', ...at(8) } });

    rig.tab('keep', 'All').click();
    expect(await lastGhost()).toMatchObject({ keep: 'all', direction: { kind: 'plane', filePath: FILE, line: 8 } });
  });

  it('refuses a curved edge as the direction in the row', async () => {
    server.routes.set('api/edge-properties', () => ({ curveType: 'circle' }));
    const rig = mount();
    pickRows(rig);
    rig.armRow('direction');
    rig.click(edge(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(rig.message()).toContain('That edge is curved');
    expect(rig.chips('direction')).toEqual([]);
  });

  it('hides the Direction row for Normal to surface and leaves its pick out, restoring both on the switch back', async () => {
    server.routes.set('api/feature-ghost', () => CURVE);
    const rig = mount();
    pickRows(rig);
    rig.armRow('direction');
    rig.shown.onPick!('x');
    expect(rig.directionShown()).toBe(true);

    rig.tab('mode', 'Normal to surface').click();
    expect(rig.directionShown()).toBe(false);
    // The hidden row hands the border back to the rows still shown.
    expect(rig.service.dialogPanel.armedRow).toBe('target');
    expect(rig.shown.axes).toBe(false);
    await vi.advanceTimersByTimeAsync(300);
    expect(sent('api/feature-ghost').at(-1)).toMatchObject({ mode: 'normal', direction: null });
    expect(sent('api/apply-feature').at(-1)).toMatchObject({ mode: 'normal', direction: null });

    rig.tab('mode', 'Along direction').click();
    expect(rig.directionShown()).toBe(true);
    expect(rig.chips('direction')).toEqual(['World X axis']);
    await vi.advanceTimersByTimeAsync(300);
    expect(sent('api/feature-ghost').at(-1)).toMatchObject({ mode: 'direction', direction: { kind: 'standard', axis: 'x' } });
  });

  it('shows the engine\'s refusal in the dialog', async () => {
    server.routes.set('api/feature-ghost', () => ({
      success: false, reason: 'project: the projection misses the target.', surface: true,
    }));
    const rig = mount();
    pickRows(rig);
    await vi.advanceTimersByTimeAsync(300);
    expect(rig.message()).toBe('project: the projection misses the target.');
  });

  it('applies the rows in pick order with the mode, the direction and Keep, and refuses an Apply with an empty row', async () => {
    const rig = mount();
    rig.service.enter();
    rig.service.handleSketchPick('ring-wire');
    rig.apply();
    await vi.advanceTimersByTimeAsync(0);
    expect(rig.message()).toContain('Pick the faces to project onto');
    expect(sent('api/apply-feature').filter(body => !body.preview)).toEqual([]);

    rig.click(face(3));
    rig.click(face(0, 'wing-surface'));
    rig.armRow('direction');
    rig.service.handleClick('axis-line', { type: 'axis', index: 0 } as SubSelection);
    rig.tab('keep', 'All').click();
    rig.apply();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent('api/apply-feature').filter(body => !body.preview)).toEqual([{
      feature: 'projected-curve',
      source: SOURCE_SKETCH,
      target: [...TARGET_FACE, { kind: 'statement', ...at(6) }],
      mode: 'direction',
      direction: { kind: 'axis', ...at(7) },
      keep: 'all',
    }]);
    expect(rig.service.isActive).toBe(false);
  });

  it('applies Normal to surface with no direction, whatever the hidden row holds', async () => {
    const rig = mount();
    pickRows(rig);
    rig.armRow('direction');
    rig.shown.onPick!('xy');
    rig.tab('mode', 'Normal to surface').click();
    rig.apply();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent('api/apply-feature').filter(body => !body.preview)).toEqual([{
      feature: 'projected-curve', source: SOURCE_SKETCH, target: TARGET_FACE, mode: 'normal', direction: null, keep: 'nearest',
    }]);
  });

  it('grows the row a double-click starts in by the edge\'s chain, never filling Onto with its second click', async () => {
    server.loop = () => ({ rim: false, members: [] });
    server.bucket = () => ({ members: [edge(1), edge(2), edge(3)] });
    const { service, chips, click } = mount();
    service.enter();
    // The viewer's double-click: its two clicks land first. The first takes
    // the edge into Curves and arms Onto, which picks faces: the second takes
    // the face behind the edge into Onto, and the double-click names it too.
    click(edge(1));
    click(face(4));
    expect(chips('target')).toEqual(['Picked face']);
    await service.handleDoubleClick('dome-solid', face(4).sub);
    // The face is taken back out of Onto; Curves grows from the edge.
    expect(chips('source')).toEqual(['Picked edge', 'Picked edge', 'Picked edge']);
    expect(chips('target')).toEqual([]);
    expect(service.dialogPanel.armedRow).toBe('target');
    expect(server.bodies('api/selection/expand-loop').map(body => body.entity)).toEqual([edge(1)]);

    // In an armed Onto, a face's gesture stays there.
    server.bucket = () => ({ members: [face(5), face(6)] });
    click(face(5));
    click(face(5));
    await service.handleDoubleClick('dome-solid', face(5).sub);
    expect(chips('target')).toEqual(['Picked face', 'Picked face']);
    expect(chips('source')).toHaveLength(3);
  });

  it('keeps a double-clicked sketch in Curves alone, the face behind its wire out of Onto', async () => {
    const { service, chips } = mount();
    service.enter();
    service.handleSketchPick('ring-wire');
    service.handleClick('dome-solid', face(3).sub);
    await service.handleDoubleClick('dome-solid', face(3).sub);
    expect(chips('source')).toEqual(['Sketch']);
    expect(chips('target')).toEqual([]);
    // A sketch is whole already: nothing to grow, and Onto takes the border again.
    expect(service.dialogPanel.armedRow).toBe('target');
    expect(server.count('api/selection/expand-bucket')).toBe(0);
  });

  it('lands a right-click group in the armed row as plain picks, and offers none for Direction', async () => {
    server.groups = [{ kind: 'tangent', label: 'Tangent Edges', members: [edge(2), edge(3)] }] as SelectionGroup[];
    const { container, service, chips, click } = mount();
    service.enter();
    service.handleContextMenu('dome-solid', edge(2).sub, 10, 10);
    await vi.advanceTimersByTimeAsync(0);
    const items = [...container.querySelectorAll<HTMLButtonElement>('#fluidcad-projected-curve-select-menu button')];
    expect(items.map(item => item.textContent)).toEqual(['Tangent Edges (2)']);
    items[0].click();
    expect(chips('source')).toEqual(['Picked edge', 'Picked edge']);
    expect(chips('target')).toEqual([]);
    expect(service.dialogPanel.armedRow).toBe('target');

    click(face(3));
    service.dialogPanel.armRow('direction');
    service.handleContextMenu('dome-solid', face(3).sub, 10, 10);
    await vi.advanceTimersByTimeAsync(0);
    expect(server.count('api/selection/groups')).toBe(1);
  });
});

describe('editing a projected curve', () => {
  const TARGET: FeatureEditTarget = at(10);
  const PARSED = {
    feature: 'projected-curve',
    sourceTexts: ['sk'],
    sourceRefs: [{ line: 2, column: 0 }],
    targetTexts: ['dome.faces()'],
    targetRefs: [null],
    sourceArg: 'sk',
    targetArg: 'dome.faces()',
    mode: 'direction',
    directionText: 'datum',
    keep: 'all',
  } as Extract<ParsedFeatureStatement, { feature: 'projected-curve' }>;
  const INFO = {
    index: 6, type: 'projected-curve',
    expectedStatement: "project(sk, dome.faces()).direction(datum).keep('all').name('Projected Curve 1')",
  };
  const BOUNDARY = { index: 6, type: 'projected-curve', line: 10, column: 0 };

  /** Open the dialog over the curve, the engine resolving its operands and direction, and land at the boundary. */
  async function openEdit(parsed: Partial<typeof PARSED> = {}, direction: unknown = { kind: 'sketch', ...at(8) }) {
    server.routes.set('api/feature/sources', () => ({
      ok: true,
      feature: 'projected-curve',
      source: [{ kind: 'sketch', ...at(2) }],
      target: [{ kind: 'entities', entities: [face(1), face(2)] }],
      direction,
    }));
    server.routes.set('api/feature-ghost', () => CURVE);
    const rig = mount(scene(true));
    rig.service.enterEdit(TARGET, { ...PARSED, ...parsed }, INFO);
    await vi.advanceTimersByTimeAsync(0);
    rig.service.handleSceneRendered(scene(true), 5, true);
    await vi.advanceTimersByTimeAsync(300);
    return rig;
  }

  const applies = () => sent('api/apply-feature').filter(body => !body.preview);
  const EDIT = { feature: 'projected-curve', edit: TARGET, expectedStatement: INFO.expectedStatement };

  it('reopens on every choice: the rows and the direction as Current chips, lit as the engine resolved them, the mode and Keep', async () => {
    const { panel, chips, activeTab, directionShown, highlights } = await openEdit();
    expect(panel().textContent).toContain('Edit project');
    expect(chips('source')).toEqual(['Current: sk']);
    expect(chips('target')).toEqual(['Current: dome.faces()']);
    expect(chips('direction')).toEqual(['Current: datum']);
    expect(activeTab('mode')).toBe('Along direction');
    expect(activeTab('keep')).toBe('All');
    expect(directionShown()).toBe(true);
    expect(server.bodies('api/feature/sources')).toEqual([{ before: BOUNDARY }]);
    expect(highlights.at(-1)).toEqual({
      entities: [face(1), face(2)], wireIds: ['ring-wire'], shapeIds: [], planeQuadIds: ['plane-quad'],
    });
    expect(sent('api/feature-ghost').at(-1)).toEqual({
      feature: 'projected-curve',
      source: GHOST_SOURCE_SKETCH,
      target: [1, 2].map(index => ({ kind: 'face', shapeId: 'dome-solid', index })),
      mode: 'direction',
      direction: { kind: 'plane', filePath: FILE, line: 8 },
      keep: 'all',
    });
  });

  it('reopens a world axis literal as that axis, and Normal to surface with its row hidden', async () => {
    const { chips, activeTab, directionShown } = await openEdit({ directionText: "'z'" }, { kind: 'opaque' });
    expect(chips('direction')).toEqual(['World Z axis']);
    expect(activeTab('mode')).toBe('Along direction');
    expect(directionShown()).toBe(true);

    const normal = await openEdit({ mode: 'normal', directionText: null, keep: 'nearest' }, null);
    expect(normal.activeTab('mode')).toBe('Normal to surface');
    expect(normal.activeTab('keep')).toBe('Nearest');
    expect(normal.directionShown()).toBe(false);
  });

  it('applies an untouched edit with nothing but the statement, its literal direction kept as written', async () => {
    const { service, apply } = await openEdit();
    apply();
    await vi.advanceTimersByTimeAsync(0);
    expect(applies()).toEqual([EDIT]);
    expect(service.isActive).toBe(false);

    const literal = await openEdit({ directionText: "'z'" }, { kind: 'opaque' });
    literal.apply();
    await vi.advanceTimersByTimeAsync(0);
    expect(applies().at(-1)).toEqual(EDIT);
  });

  it('sends only Keep when only Keep changed, and only the mode when only the mode did', async () => {
    const rig = await openEdit({ directionText: null }, null);
    rig.tab('keep', 'Nearest').click();
    rig.apply();
    await vi.advanceTimersByTimeAsync(0);
    expect(applies().at(-1)).toEqual({ ...EDIT, keep: 'nearest' });

    const normal = await openEdit({ directionText: null }, null);
    normal.tab('mode', 'Normal to surface').click();
    normal.apply();
    await vi.advanceTimersByTimeAsync(0);
    expect(applies().at(-1)).toEqual({ ...EDIT, mode: 'normal' });
  });

  it('rewrites only the re-picked row: edges and faces with the boundary, a surface without', async () => {
    const rig = await openEdit();
    // The statement's faces all resolved: a pick adds to them.
    rig.armRow('target');
    rig.click(face(5));
    expect(rig.chips('target')).toEqual(['Picked face', 'Picked face', 'Picked face']);
    rig.apply();
    await vi.advanceTimersByTimeAsync(0);
    expect(applies().at(-1)).toEqual({
      ...EDIT,
      before: BOUNDARY,
      target: [1, 2, 5].map(index => ({ kind: 'face', shapeId: 'dome-solid', index })),
    });

    const surface = await openEdit();
    surface.armRow('target');
    surface.service.handleTimelinePick(scene()[3]);
    // A list whose kept faces resolved starts from them.
    surface.click(face(1));
    surface.click(face(2));
    expect(surface.chips('target')).toEqual(['Load 1']);
    surface.apply();
    await vi.advanceTimersByTimeAsync(0);
    expect(applies().at(-1)).toEqual({ ...EDIT, target: [{ kind: 'statement', ...at(6) }] });
  });

  it('keeps, clears or replaces the direction', async () => {
    straightAndFlat();
    const rig = await openEdit();
    // Replaced by a picked edge, which needs the boundary.
    rig.armRow('direction');
    rig.click(edge(2));
    await vi.advanceTimersByTimeAsync(0);
    expect(rig.chips('direction')).toEqual(['Picked edge']);
    rig.apply();
    await vi.advanceTimersByTimeAsync(0);
    expect(applies().at(-1)).toEqual({ ...EDIT, before: BOUNDARY, direction: { kind: 'edge', entity: edge(2) } });

    // The re-pick's ✕ goes back to the statement's own; that one's ✕ clears it.
    const cleared = await openEdit();
    cleared.armRow('direction');
    cleared.shown.onPick!('y');
    cleared.removeDirection();
    expect(cleared.chips('direction')).toEqual(['Current: datum']);
    cleared.removeDirection();
    expect(cleared.chips('direction')).toEqual([]);
    await vi.advanceTimersByTimeAsync(300);
    expect(sent('api/feature-ghost').at(-1)).toMatchObject({ direction: null });
    expect(sent('api/apply-feature').at(-1)).toMatchObject({ direction: { kind: 'cleared' }, preview: true });
    cleared.apply();
    await vi.advanceTimersByTimeAsync(0);
    expect(applies().at(-1)).toEqual({ ...EDIT, direction: { kind: 'cleared' } });

    // Replaced by a world axis, which names no pick.
    const replaced = await openEdit();
    replaced.armRow('direction');
    replaced.shown.onPick!('y');
    replaced.apply();
    await vi.advanceTimersByTimeAsync(0);
    expect(applies().at(-1)).toEqual({ ...EDIT, direction: { kind: 'standard', axis: 'y' } });
  });

  it('switching an edit with a direction to Normal to surface clears the direction, and switching back keeps it', async () => {
    const rig = await openEdit();
    rig.tab('mode', 'Normal to surface').click();
    await vi.advanceTimersByTimeAsync(300);
    expect(sent('api/apply-feature').at(-1)).toMatchObject({ mode: 'normal', direction: { kind: 'cleared' }, preview: true });
    expect(sent('api/feature-ghost').at(-1)).toMatchObject({ mode: 'normal', direction: null });
    rig.apply();
    await vi.advanceTimersByTimeAsync(0);
    expect(applies().at(-1)).toEqual({ ...EDIT, mode: 'normal', direction: { kind: 'cleared' } });

    const back = await openEdit();
    back.tab('mode', 'Normal to surface').click();
    back.tab('mode', 'Along direction').click();
    expect(back.chips('direction')).toEqual(['Current: datum']);
    back.apply();
    await vi.advanceTimersByTimeAsync(0);
    expect(applies().at(-1)).toEqual(EDIT);
  });
});
