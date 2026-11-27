// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PerspectiveCamera, Scene } from 'three';
import type { FeatureEditTarget, ParsedFeatureStatement, SelectionGroup } from '../src/api';
import { FeatureGhostOverlay } from '../src/interactive/create-feature/feature-ghost';
import { IntersectionCurveFeatureService } from '../src/interactive/create-feature/intersection-curve-service';
import { ToolMenu } from '../src/interactive/create-feature/tool-menu';
import { Navbar } from '../src/ui/navbar';
import { toolIndex } from '../src/ui/quick-find/tool-index';
import { TOOLBAR_BTN_ACTIVE, TOOLBAR_BTN_BASE } from '../src/ui/toolbar-styles';
import type { SceneObjectRender } from '../src/types';
import type { SelectedEntity, Viewer } from '../src/viewer';
import { FakeSelectionServer } from './fixtures/fake-selection-server';

// The Intersect dialog of the Curves menu: `intersect(first, second)` outside
// a sketch. Two surface rows, First and Second, take faces of bodies as
// themselves and surfaces whole; First opens armed and its first pick hands
// the border to an empty Second. The curve previews as a wire once both rows
// hold a pick, and the engine's refusal reads in the dialog. A timeline
// double-click reopens it on the statement's own arguments, and Apply
// rewrites only the row that was re-picked. The dialog talks to a stubbed
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
const services: IntersectionCurveFeatureService[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  server = new FakeSelectionServer().install();
});

afterEach(() => {
  for (const service of services.splice(0)) {
    service.exit();
  }
  for (const menu of menus.splice(0)) {
    menu.close();
  }
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

const FILE = '/ws/pipe.part.js';
const at = (line: number, column = 0) => ({ filePath: FILE, line, column });
const MESH = [{ vertices: [0, 0, 0, 1, 0, 0], normals: [], indices: [0, 1] }];
const face = (index: number, shapeId = 'block-solid'): SelectedEntity => ({ shapeId, sub: { type: 'face', index } });

/** A sloped plane, a block, a loaded surface and, with `withCurve`, the curve an edit opens over. */
function scene(withCurve = false): SceneObjectRender[] {
  return [
    {
      id: 'p', type: 'plane', name: 'Plane 1', ownShapes: [], sourceLocation: at(4),
      sceneShapes: [{ shapeId: 'p-quad', shapeType: 'face', isMetaShape: true, meshes: MESH }],
    },
    {
      id: 'block', type: 'extrude', name: 'Extrude 1', ownShapes: [], sourceLocation: at(5),
      sceneShapes: [{ shapeId: 'block-solid', shapeType: 'solid', meshes: MESH }],
    },
    {
      id: 'wing', type: 'load', name: 'Load 1', ownShapes: [], sourceLocation: at(6),
      sceneShapes: [{ shapeId: 'wing-surface', shapeType: 'surface', meshes: MESH }],
    },
    ...(withCurve ? [{
      id: 'ic', type: 'intersection-curve', name: 'Intersect 1', ownShapes: [], sourceLocation: at(8),
      sceneShapes: [{ shapeId: 'ic-wire', shapeType: 'wire', meshes: MESH }],
    }] : []),
  ] as unknown as SceneObjectRender[];
}

/** A part holding nothing to cut: a plane and a sketch. */
function bodilessScene(): SceneObjectRender[] {
  return [scene()[0]];
}

/** A viewer that records the highlight; every other call is a no-op. */
function stubViewer() {
  const highlights: { entities: SelectedEntity[]; shapeIds: string[] }[] = [];
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
    highlightEntities: (entities: SelectedEntity[], _wires: string[] = [], shapeIds: string[] = []) =>
      highlights.push({ entities, shapeIds }),
    clearHighlight: () => highlights.push({ entities: [], shapeIds: [] }),
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

/** The bar as main.ts builds it: the Curves menu with Helix and Intersect, the dialog opened from its cell. */
function mount(objects: SceneObjectRender[] = scene()) {
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
  const cell = curves.add({
    id: 'intersection-curve',
    label: 'Intersect',
    iconSrc: 'icons/intersection-curve.png',
    tip: 'The curve where two sets of faces or surfaces meet',
    order: 10,
  });
  const { viewer, highlights, channels } = stubViewer();
  const service = new IntersectionCurveFeatureService(container, viewer, navbar, cell);
  services.push(service);
  service.update(objects);

  const menuButton = container.querySelector<HTMLElement>('[data-tool="curves"] button')!;
  const cellButton = (id = 'intersection-curve') => {
    if (!curves.isOpen) {
      menuButton.click();
    }
    return document.querySelector<HTMLButtonElement>(`[data-role="curves-menu"] [data-tool="${id}"] button`)!;
  };
  const panel = () => document.getElementById('fluidcad-intersection-curve-panel')!;
  const chips = (row: 'first' | 'second') => [...panel().querySelectorAll<HTMLElement>(`[data-role="${row}-slot"] span.truncate[title]`)]
    .map(el => el.textContent);
  const message = () => panel().querySelector('[data-role="message"]')!.textContent;
  const armRow = (row: 'first' | 'second') => panel().querySelector<HTMLElement>(`[data-role="${row}-slot"]`)!.click();
  const apply = () => panel().querySelector<HTMLButtonElement>('[data-role="apply"]')!.click();
  const click = (entity: SelectedEntity) => service.handleClick(entity.shapeId, entity.sub);
  return { container, curves, cell, service, viewer, highlights, channels, menuButton, cellButton, panel, chips, message, armRow, apply, click };
}

/** The last bodies sent to a route, without the fields the page adds (the active part, the value scope). */
const sent = (route: string) => server.bodies(route).map(({ activePart: _p, valueScope: _s, ...body }) => body);

/** The ghost route's answer: a curve. */
const CURVE = { success: true, solids: [{ kind: 'wire', meshes: [] }] };

describe('Intersect in the Curves menu', () => {
  it('has a cell after Helix that opens the dialog and reads as armed while it is open', () => {
    const { curves, cell, service, menuButton, cellButton, panel } = mount();
    menuButton.click();
    expect([...document.querySelectorAll<HTMLElement>('[data-role="curves-menu"] [data-tool]')]
      .map(el => el.dataset.tool)).toEqual(['helix', 'intersection-curve']);
    expect(cellButton().textContent).toBe('Intersect');

    cellButton().click();
    expect(service.isActive).toBe(true);
    expect(curves.isOpen).toBe(false);
    expect(cell.active).toBe(true);
    expect(menuButton.className).toBe(TOOLBAR_BTN_ACTIVE);
    expect(panel().classList.contains('hidden')).toBe(false);
    expect(panel().textContent).toContain('First');
    expect(panel().textContent).toContain('Second');

    cellButton().click();
    expect(service.isActive).toBe(false);
    expect(menuButton.className).toBe(TOOLBAR_BTN_BASE);
  });

  it('greys its cell until the scene holds a body to cut, a solid or a surface', () => {
    const { service, cell, cellButton } = mount(bodilessScene());
    expect(cell.disabled).toBe(true);
    expect(cellButton().disabled).toBe(true);
    expect(toolIndex.get('part:intersection-curve')!.isDisabled!()).toBe(true);
    service.update(scene().filter(o => o.id !== 'block'));
    expect(cellButton().disabled).toBe(false);
    service.update(scene().filter(o => o.id !== 'wing'));
    expect(cellButton().disabled).toBe(false);
  });

  it('is run by Quick Find as part:intersection-curve under Curves, and found by section, crossing and seam', () => {
    const { service } = mount();
    const entry = toolIndex.get('part:intersection-curve')!;
    expect(entry.bench).toBe('Curves');
    expect(entry.iconSrc).toBe('icons/intersection-curve.png');
    for (const word of ['section', 'crossing', 'seam', 'intersect']) {
      expect(toolIndex.search(word).map(match => match.tool.id), word).toContain('part:intersection-curve');
    }
    entry.run();
    expect(service.isActive).toBe(true);
    expect(entry.isActive!()).toBe(true);
  });
});

describe('the Intersect dialog', () => {
  it('opens with First armed, and First\'s first pick hands the border to an empty Second', () => {
    const { service, channels, chips, armRow, click } = mount();
    service.enter();
    const panel = service.dialogPanel;
    expect(panel.armedRow).toBe('first');
    // Both rows are surface rows: the viewer offers faces only.
    expect(channels.pickFilter).toBe('face');

    click(face(3));
    expect(chips('first')).toEqual(['Picked face']);
    expect(panel.armedRow).toBe('second');

    click(face(0, 'wing-surface'));
    expect(chips('second')).toEqual(['Load 1']);
    // A Second that holds a pick stays armed for more.
    expect(panel.armedRow).toBe('second');

    // A click on a row arms it; Second holding something, First keeps it.
    armRow('first');
    expect(panel.armedRow).toBe('first');
    click(face(4));
    expect(chips('first')).toEqual(['Picked face', 'Picked face']);
    expect(panel.armedRow).toBe('first');
  });

  it('takes a face of a solid as itself, a surface whole, and a surface\'s timeline row, refusing a row with no surface', () => {
    const { service, chips, message, highlights, click } = mount();
    service.enter();
    click(face(0, 'wing-surface'));
    expect(chips('first')).toEqual(['Load 1']);
    // The surface lights whole.
    expect(highlights.at(-1)).toEqual({ entities: [], shapeIds: ['wing-surface'] });

    expect(service.handleTimelinePick(scene()[1])).toBe(true);
    expect(message()).toContain('Extrude 1 holds no surface');
    expect(chips('second')).toEqual([]);

    expect(service.handleTimelinePick(scene()[2])).toBe(true);
    expect(chips('second')).toEqual(['Load 1']);
    expect(message()).toBe('');
  });

  it('previews nothing until both rows hold a pick, then sends both rows, the curve drawn as a wire', async () => {
    server.routes.set('api/feature-ghost', () => CURVE);
    const set = vi.spyOn(FeatureGhostOverlay.prototype, 'set').mockImplementation(() => {});
    const { service, click } = mount();
    service.enter();
    click(face(3));
    await vi.advanceTimersByTimeAsync(300);
    expect(server.count('api/apply-feature')).toBe(0);
    expect(server.count('api/feature-ghost')).toBe(0);

    click(face(0, 'wing-surface'));
    await vi.advanceTimersByTimeAsync(300);
    expect(sent('api/apply-feature')).toEqual([{
      feature: 'intersection-curve',
      first: [{ kind: 'face', shapeId: 'block-solid', index: 3 }],
      second: [{ kind: 'statement', ...at(6) }],
      preview: true,
    }]);
    expect(sent('api/feature-ghost')).toEqual([{
      feature: 'intersection-curve',
      first: [{ kind: 'face', shapeId: 'block-solid', index: 3 }],
      second: [{ kind: 'statement', filePath: FILE, line: 6 }],
    }]);
    expect(set).toHaveBeenLastCalledWith(CURVE.solids, 'wire');
  });

  it('shows the engine\'s refusal in the dialog', async () => {
    server.routes.set('api/feature-ghost', () => ({
      success: false, reason: 'intersect: the two selections do not cross.', surface: true,
    }));
    const { service, message, click } = mount();
    service.enter();
    click(face(3));
    click(face(5));
    await vi.advanceTimersByTimeAsync(300);
    expect(message()).toBe('intersect: the two selections do not cross.');
  });

  it('applies both rows\' picks in pick order and closes, and refuses an Apply with an empty row', async () => {
    const { service, message, apply, armRow, click } = mount();
    service.enter();
    click(face(3));
    apply();
    await vi.advanceTimersByTimeAsync(0);
    expect(message()).toContain('Pick the second selection');
    expect(sent('api/apply-feature').filter(body => !body.preview)).toEqual([]);

    click(face(0, 'wing-surface'));
    armRow('first');
    click(face(4));
    apply();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent('api/apply-feature').filter(body => !body.preview)).toEqual([{
      feature: 'intersection-curve',
      first: [{ kind: 'face', shapeId: 'block-solid', index: 3 }, { kind: 'face', shapeId: 'block-solid', index: 4 }],
      second: [{ kind: 'statement', ...at(6) }],
    }]);
    expect(service.isActive).toBe(false);
  });

  it('grows the row a double-click starts in by the face\'s bucket, then hands the border on', async () => {
    server.bucket = () => ({ members: [face(1), face(2), face(3)] });
    const { service, chips, click } = mount();
    service.enter();
    // The viewer's double-click: its two clicks land first. The first fills
    // First and arms Second; the second is taken back out of Second.
    click(face(1));
    click(face(1));
    await service.handleDoubleClick('block-solid', face(1).sub);
    expect(chips('first')).toEqual(['Picked face', 'Picked face', 'Picked face']);
    expect(chips('second')).toEqual([]);
    expect(service.dialogPanel.armedRow).toBe('second');
    expect(server.bodies('api/selection/expand-bucket').map(body => body.entity)).toEqual([face(1)]);

    // In an armed Second, the gesture stays there.
    click(face(5));
    click(face(5));
    server.bucket = () => ({ members: [face(5), face(6)] });
    await service.handleDoubleClick('block-solid', face(5).sub);
    expect(chips('second')).toEqual(['Picked face', 'Picked face']);
    expect(chips('first')).toHaveLength(3);
  });

  it('lands a right-click group in the armed row as plain faces', async () => {
    const groups: SelectionGroup[] = [{ kind: 'classified', label: 'Extrude Side Faces', members: [face(2), face(3), face(4)] }];
    server.groups = groups;
    const { container, service, chips, click } = mount();
    service.enter();
    click(face(0, 'wing-surface'));
    expect(service.dialogPanel.armedRow).toBe('second');

    service.handleContextMenu('block-solid', face(3).sub, 10, 10);
    await vi.advanceTimersByTimeAsync(0);
    const items = [...container.querySelectorAll<HTMLButtonElement>('#fluidcad-intersection-curve-select-menu button')];
    expect(items.map(item => item.textContent)).toEqual(['Extrude Side Faces (3)']);
    items[0].click();
    expect(chips('second')).toEqual(['Picked face', 'Picked face', 'Picked face']);
    expect(chips('first')).toEqual(['Load 1']);

    // A face of a surface stands for the surface: no menu to grow by.
    server.groups = groups;
    service.handleContextMenu('wing-surface', face(0, 'wing-surface').sub, 10, 10);
    await vi.advanceTimersByTimeAsync(0);
    expect(server.count('api/selection/groups')).toBe(1);
  });
});

describe('editing an intersection curve', () => {
  const TARGET: FeatureEditTarget = at(8);
  const PARSED = {
    feature: 'intersection-curve',
    firstTexts: ['e.sideFaces()'],
    firstRefs: [null],
    secondTexts: ['p'],
    secondRefs: [{ line: 4, column: 0 }],
    firstArg: 'e.sideFaces()',
    secondArg: 'p',
  } as Extract<ParsedFeatureStatement, { feature: 'intersection-curve' }>;
  const INFO = { index: 3, type: 'intersection-curve', expectedStatement: "intersect(e.sideFaces(), p).name('Intersect 1')" };
  const BOUNDARY = { index: 3, type: 'intersection-curve', line: 8, column: 0 };

  /** Open the dialog over the curve, the engine resolving its operands, and land at the boundary. */
  async function openEdit() {
    server.routes.set('api/feature/sources', () => ({
      ok: true,
      feature: 'intersection-curve',
      first: [{ kind: 'entities', entities: [face(1), face(2)] }],
      second: [{ kind: 'sketch', ...at(4) }],
    }));
    server.routes.set('api/feature-ghost', () => CURVE);
    const rig = mount(scene(true));
    rig.service.enterEdit(TARGET, PARSED, INFO);
    await vi.advanceTimersByTimeAsync(0);
    rig.service.handleSceneRendered(scene(true), 2, true);
    await vi.advanceTimersByTimeAsync(300);
    return rig;
  }

  const applies = () => sent('api/apply-feature').filter(body => !body.preview);

  it('reopens on both arguments as Current chips, lit as the engine resolved them, and previews the curve they make', async () => {
    const { chips, highlights, panel } = await openEdit();
    expect(panel().textContent).toContain('Edit intersect');
    expect(chips('first')).toEqual(['Current: e.sideFaces()']);
    expect(chips('second')).toEqual(['Current: p']);
    expect(server.bodies('api/feature/sources')).toEqual([{ before: BOUNDARY }]);
    expect(highlights.at(-1)).toEqual({ entities: [face(1), face(2)], shapeIds: [] });
    expect(sent('api/feature-ghost').at(-1)).toEqual({
      feature: 'intersection-curve',
      first: [{ kind: 'face', shapeId: 'block-solid', index: 1 }, { kind: 'face', shapeId: 'block-solid', index: 2 }],
      second: [{ kind: 'statement', filePath: FILE, line: 4 }],
    });
  });

  it('applies an untouched edit with neither row, so both arguments, the plane among them, are written back as they were', async () => {
    const { service, apply } = await openEdit();
    apply();
    await vi.advanceTimersByTimeAsync(0);
    expect(applies()).toEqual([{
      feature: 'intersection-curve',
      edit: TARGET,
      expectedStatement: INFO.expectedStatement,
    }]);
    expect(service.isActive).toBe(false);
  });

  it('rewrites only the re-picked row: faces with the boundary, a surface without, the plane kept', async () => {
    const { apply, chips, click } = await openEdit();
    // The statement's faces all resolved: a pick adds to them.
    click(face(5));
    expect(chips('first')).toEqual(['Picked face', 'Picked face', 'Picked face']);
    apply();
    await vi.advanceTimersByTimeAsync(0);
    expect(applies().at(-1)).toEqual({
      feature: 'intersection-curve',
      edit: TARGET,
      expectedStatement: INFO.expectedStatement,
      before: BOUNDARY,
      first: [1, 2, 5].map(index => ({ kind: 'face', shapeId: 'block-solid', index })),
    });
  });

  it('re-picks the second row with a surface, which needs no boundary', async () => {
    const { apply, armRow, chips, click } = await openEdit();
    armRow('second');
    click(face(0, 'wing-surface'));
    // The plane is no surface the row could start from: the pick replaces it.
    expect(chips('second')).toEqual(['Load 1']);
    expect(chips('first')).toEqual(['Current: e.sideFaces()']);
    apply();
    await vi.advanceTimersByTimeAsync(0);
    expect(applies().at(-1)).toEqual({
      feature: 'intersection-curve',
      edit: TARGET,
      expectedStatement: INFO.expectedStatement,
      second: [{ kind: 'statement', ...at(6) }],
    });
  });
});
