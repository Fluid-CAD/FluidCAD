// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrthographicCamera, Scene } from 'three';
import { setActivePartProvider, type FeatureEditTarget } from '../src/api';
import { POSITION_ONLY_HINT } from '../src/interactive/create-feature/bridge-panel';
import { BridgeFeatureService } from '../src/interactive/create-feature/bridge-service';
import { CLOSED_EDGE_REFUSAL } from '../src/interactive/create-feature/end-row';
import { FeatureGhostOverlay } from '../src/interactive/create-feature/feature-ghost';
import { ToolMenu } from '../src/interactive/create-feature/tool-menu';
import { FeatureDialogRegistry, type ParsedFeatureOf } from '../src/interactive/feature-dialog-registry';
import { PartFeatureDialogs, type PartDialogServices } from '../src/interactive/part-feature-dialogs';
import { Navbar } from '../src/ui/navbar';
import { toolIndex } from '../src/ui/quick-find/tool-index';
import { TOOLBAR_BTN_ACTIVE, TOOLBAR_BTN_BASE } from '../src/ui/toolbar-styles';
import type { SceneObjectRender, SubSelection } from '../src/types';
import type { SelectedEntity, Viewer } from '../src/viewer';
import { FakeSelectionServer } from './fixtures/fake-selection-server';

// The Bridge dialog of the Curves menu: `bridge(from, to)`, a smooth curve
// joining two curve ends. Its rows are the two ends, each with how the
// bridge meets it (Position, Tangent, Curvature) and its magnitude, hidden
// at Position. From opens armed and its pick hands the border to To. While
// an end row is armed, hovering an edge floats its nearer end (the anchor
// suggestions, limited to start and end) and a click takes it — an edge of
// a sketch as the vertex at that end; a vertex click takes the vertex, a
// corner of a body or a point locking that end at Position. The bridge
// previews as a wire once both ends hold a pick and the magnitudes on show
// read, and the engine's refusal reads in the dialog. A timeline
// double-click on a bridge row reopens it on the statement's own ends,
// continuities and magnitudes, and Apply sends only what changed. The
// dialog talks to a stubbed network (FakeSelectionServer): the shared
// worker would bind it to another test file's api mock.

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
const services: BridgeFeatureService[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  server = new FakeSelectionServer().install();
  // The anchors of each edge the rail asks about: its centre, start and end.
  server.routes.set('api/selection/connector-anchors', body => ANCHORS[`${body.entity.shapeId}:${body.entity.sub.index}`]
    ?? { success: false, reason: 'pick does not resolve to a sub-shape in the current scene' });
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
  setActivePartProvider(() => null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

const FILE = '/ws/rails.part.js';
const at = (line: number, column = 0) => ({ filePath: FILE, line, column });
const MESH = [{ vertices: [0, 0, 0, 1, 0, 0], normals: [], indices: [0, 1] }];
type Point = [number, number, number];
const edge = (index: number, shapeId = 'box-solid'): SelectedEntity => ({ shapeId, sub: { type: 'edge', index } });
const vertex = (index: number, shapeId: string, position: Point): NonNullable<SubSelection> =>
  ({ type: 'vertex', index, position: { x: position[0], y: position[1], z: position[2] } });

/** A 40 × 20 × 10 box's corners, in topology order. */
const BOX: Point[] = [[0, 0, 0], [40, 0, 0], [40, 20, 0], [0, 20, 0], [0, 0, 10], [40, 0, 10], [40, 20, 10], [0, 20, 10]];
/** The projected curve: one edge from (-30, 0, 5) to (-10, 0, 5). */
const RAIL: Point[] = [[-30, 0, 5], [-10, 0, 5]];
/** A sketch line from (0, 30) to (10, 40), and a sketch point at (30, 2). */
const LINE: Point[] = [[0, 30, 0], [10, 40, 0]];
const POINT: Point = [30, 2, 0];

/** A box, a projected curve, a sketch with a line and a point, a loaded surface and, with `withBridge`, the bridge an edit opens over. */
function scene(withBridge = false): SceneObjectRender[] {
  return [
    {
      id: 'box', type: 'extrude', name: 'Extrude 1', ownShapes: [], sourceLocation: at(3),
      sceneShapes: [{ shapeId: 'box-solid', shapeType: 'solid', meshes: MESH, vertices: BOX.flat() }],
    },
    {
      id: 'pc', type: 'projected-curve', name: 'Projected Curve 1', ownShapes: [], sourceLocation: at(4, 10),
      sceneShapes: [{ shapeId: 'pc-wire', shapeType: 'wire', meshes: MESH, vertices: RAIL.flat() }],
    },
    { id: 'sk', type: 'sketch', name: 'Sketch 1', isContainer: true, ownShapes: [], sceneShapes: [], sourceLocation: at(5) },
    {
      id: 'l1', type: 'line', parentId: 'sk', ownShapes: [], sourceLocation: at(6),
      sceneShapes: [{ shapeId: 'l1-edge', shapeType: 'edge', meshes: MESH, vertices: LINE.flat() }],
    },
    {
      id: 'p1', type: 'point', parentId: 'sk', ownShapes: [], sourceLocation: at(7),
      sceneShapes: [{ shapeId: 'p1-vertex', shapeType: 'vertex', isMetaShape: true, meshes: [], vertices: POINT }],
    },
    {
      id: 'wing', type: 'load', name: 'Load 1', ownShapes: [], sourceLocation: at(8),
      sceneShapes: [{ shapeId: 'wing-surface', shapeType: 'surface', meshes: MESH }],
    },
    ...(withBridge ? [{
      id: 'br', type: 'bridge', name: 'Bridge 1', ownShapes: [], sourceLocation: at(10),
      sceneShapes: [{ shapeId: 'br-wire', shapeType: 'wire', meshes: MESH }],
    }] : []),
  ] as unknown as SceneObjectRender[];
}
const rowOf = (id: string) => scene(true).find(o => o.id === id)!;

/** One anchor the rail offers, its frame at `origin`. */
function anchor(kind: 'center' | 'start' | 'end', origin: Point) {
  const point = { x: origin[0], y: origin[1], z: origin[2] };
  return {
    anchor: { kind }, suffix: `.${kind}()`, hoverPoint: point,
    frame: { origin: point, xDirection: { x: 1, y: 0, z: 0 }, yDirection: { x: 0, y: 1, z: 0 }, normal: { x: 0, y: 0, z: 1 } },
  };
}
/** The engine's answer for an edge from `start` to `end`: its centre, start and end. */
function edgeAnchors(start: Point, end: Point) {
  const mid: Point = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2, (start[2] + end[2]) / 2];
  return { success: true, inPart: false, defaultName: null, anchors: [anchor('center', mid), anchor('start', start), anchor('end', end)] };
}
/** The edges the rail is asked about, by `shapeId:index`. A full circle offers its centre only. */
const ANCHORS: Record<string, unknown> = {
  'box-solid:3': edgeAnchors(BOX[4], BOX[5]),
  'box-solid:9': edgeAnchors(BOX[7], BOX[6]),
  'pc-wire:0': edgeAnchors(RAIL[0], RAIL[1]),
  'l1-edge:0': edgeAnchors(LINE[0], LINE[1]),
  'ring-wire:0': { success: true, inPart: false, defaultName: null, anchors: [anchor('center', [0, 0, 0])] },
};

/** Looking down -Z at a 100 × 100 viewport: world (x, y) lands at screen (x + 50, 50 − y). */
function topCamera(): OrthographicCamera {
  const camera = new OrthographicCamera(-50, 50, 50, -50, 0.1, 1000);
  camera.position.set(0, 0, 100);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  return camera;
}
/** Where a world point shows on the stub viewport. */
const screen = (point: Point) => ({ x: point[0] + 50, y: 50 - point[1] });

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
    sceneContext: {
      scene: new Scene(),
      camera: topCamera(),
      renderer: { domElement: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) } },
      requestRender: () => {},
    },
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

/** The bar as main.ts builds it: the Curves menu with Helix, Intersect, Project, Offset and Bridge, the dialog opened from its cell. */
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
  const cell = curves.add({ id: 'bridge', label: 'Bridge', iconSrc: 'icons/bridge.png', tip: 'Join two curve ends smoothly', order: 40 });
  curves.add({ id: 'offset-curve', label: 'Offset', iconSrc: 'icons/offset-curve.png', tip: 'Offset', order: 30 });
  curves.add({ id: 'helix', label: 'Helix', iconSrc: 'icons/helix.png', tip: 'Build a helix', order: 0 });
  curves.add({ id: 'projected-curve', label: 'Project', iconSrc: 'icons/projected-curve.png', tip: 'Project', order: 20 });
  curves.add({ id: 'intersection-curve', label: 'Intersect', iconSrc: 'icons/intersection-curve.png', tip: 'Intersect', order: 10 });
  const { viewer, highlights, channels } = stubViewer();
  const service = new BridgeFeatureService(container, viewer, navbar, cell);
  services.push(service);
  service.update(objects);

  const menuButton = container.querySelector<HTMLElement>('[data-tool="curves"] button')!;
  const cellButton = (id = 'bridge') => {
    if (!curves.isOpen) {
      menuButton.click();
    }
    return document.querySelector<HTMLButtonElement>(`[data-role="curves-menu"] [data-tool="${id}"] button`)!;
  };
  const panel = () => document.getElementById('fluidcad-bridge-panel')!;
  const chips = (end: 'from' | 'to') =>
    [...panel().querySelectorAll<HTMLElement>(`[data-role="${end}-slot"] span.truncate[title]`)].map(el => el.textContent);
  const message = () => panel().querySelector('[data-role="message"]')!.textContent;
  const armEnd = (end: 'from' | 'to') => panel().querySelector<HTMLElement>(`[data-role="${end}-slot"]`)!.click();
  const tabs = (end: 'from' | 'to') => [...panel().querySelectorAll<HTMLButtonElement>(`[data-role="${end}-continuity"] button`)];
  /** The continuity tab of `end` that reads active. */
  const continuity = (end: 'from' | 'to') => tabs(end).find(tab => tab.className.includes('btn-primary'))!.textContent;
  const chooseContinuity = (end: 'from' | 'to', label: 'Position' | 'Tangent' | 'Curvature') =>
    tabs(end).find(tab => tab.textContent === label)!.click();
  const muted = (end: 'from' | 'to') => tabs(end).filter(tab => tab.classList.contains('opacity-40')).map(tab => tab.textContent);
  const hint = (end: 'from' | 'to') => panel().querySelector<HTMLElement>(`[data-role="${end}-continuity-hint"]`)!;
  const magnitudeRow = (end: 'from' | 'to') => panel().querySelector<HTMLElement>(`[data-role="${end}-magnitude-row"]`)!;
  const magnitudeInput = (end: 'from' | 'to') => panel().querySelector<HTMLInputElement>(`[data-role="${end}-magnitude"]`)!;
  /** Type into a magnitude field, as the user does: the text, then the input event. */
  const typeMagnitude = (end: 'from' | 'to', text: string) => {
    magnitudeInput(end).value = text;
    magnitudeInput(end).dispatchEvent(new Event('input', { bubbles: true }));
  };
  const apply = () => panel().querySelector<HTMLButtonElement>('[data-role="apply"]')!.click();
  /** Hover an edge near `point`, let the rail fetch its ends, then click there. */
  const pickEdgeEnd = async (entity: SelectedEntity, point: Point) => {
    const { x, y } = screen(point);
    service.handleHover(entity.shapeId, entity.sub, x, y);
    await vi.advanceTimersByTimeAsync(150);
    service.handleClick(entity.shapeId, entity.sub);
    await vi.advanceTimersByTimeAsync(0);
  };
  const pickVertex = async (shapeId: string, index: number, position: Point) => {
    service.handleClick(shapeId, vertex(index, shapeId, position));
    await vi.advanceTimersByTimeAsync(0);
  };
  return {
    container, curves, cell, service, viewer, highlights, channels, menuButton, cellButton, panel, chips, message, armEnd,
    tabs, continuity, chooseContinuity, muted, hint, magnitudeRow, magnitudeInput, typeMagnitude, apply, pickEdgeEnd, pickVertex,
  };
}

/** The bodies sent to a route, without the fields the page adds (the active part, the value scope). */
const sent = (route: string) => server.bodies(route).map(({ activePart: _p, valueScope: _s, ...body }) => body);
/** What Apply sent, previews left out. */
const applies = () => sent('api/apply-feature').filter(body => !body.preview);

/** The ghost route's answer: a curve. */
const CURVE = { success: true, solids: [{ kind: 'wire', meshes: [] }] };

/** The end of the box's top front edge, the start of the projected curve. */
const BOX_END = { kind: 'edge-end', shapeId: 'box-solid', index: 3, end: 'end' };
const RAIL_START = { kind: 'edge-end', shapeId: 'pc-wire', index: 0, end: 'start' };
/** The defaults on both ends. */
const DEFAULTS = { startContinuity: 'g1', endContinuity: 'g1', startMagnitude: 1, endMagnitude: 1 };

/** Open the dialog and pick the end of the box's top front edge, then the start of the projected curve. */
async function pickEnds(rig: ReturnType<typeof mount>): Promise<void> {
  rig.service.enter();
  await rig.pickEdgeEnd(edge(3), BOX[5]);
  await rig.pickEdgeEnd(edge(0, 'pc-wire'), RAIL[0]);
}

describe('Bridge in the Curves menu', () => {
  it('has a cell after Offset that opens the Bridge dialog and reads as armed while it is open', () => {
    const { curves, cell, service, menuButton, cellButton, panel } = mount();
    menuButton.click();
    expect([...document.querySelectorAll<HTMLElement>('[data-role="curves-menu"] [data-tool]')].map(el => el.dataset.tool))
      .toEqual(['helix', 'intersection-curve', 'projected-curve', 'offset-curve', 'bridge']);
    expect(cellButton().textContent).toBe('Bridge');

    cellButton().click();
    expect(service.isActive).toBe(true);
    expect(curves.isOpen).toBe(false);
    expect(cell.active).toBe(true);
    expect(menuButton.className).toBe(TOOLBAR_BTN_ACTIVE);
    expect(panel().classList.contains('hidden')).toBe(false);
    for (const label of ['Bridge', 'From', 'To', 'Continuity', 'Magnitude', 'Position', 'Tangent', 'Curvature']) {
      expect(panel().textContent).toContain(label);
    }

    cellButton().click();
    expect(service.isActive).toBe(false);
    expect(menuButton.className).toBe(TOOLBAR_BTN_BASE);
  });

  it('greys its cell until the scene holds a body, a curve or a sketch\'s edge', () => {
    const planeOnly = [{ id: 'pl', type: 'plane', name: 'Plane 1', ownShapes: [], sourceLocation: at(1),
      sceneShapes: [{ shapeId: 'pl-quad', shapeType: 'face', isMetaShape: true, meshes: MESH }] }] as unknown as SceneObjectRender[];
    const { service, cell, cellButton } = mount(planeOnly);
    expect(cell.disabled).toBe(true);
    expect(cellButton().disabled).toBe(true);
    expect(toolIndex.get('part:bridge')!.isDisabled!()).toBe(true);
    for (const kept of [['box'], ['wing'], ['pc'], ['sk', 'l1']]) {
      service.update(scene().filter(o => kept.includes(o.id)));
      expect(cellButton().disabled, kept.join()).toBe(false);
    }
  });

  it('is run by Quick Find as part:bridge under Curves, and found by bridging curve, blend curve and connect curves', () => {
    const { service } = mount();
    const entry = toolIndex.get('part:bridge')!;
    expect(entry.bench).toBe('Curves');
    expect(entry.tip).toBe('Join two curve ends smoothly');
    expect(entry.iconSrc).toBe('icons/bridge.png');
    for (const word of ['bridge', 'bridging curve', 'blend curve', 'connect curves']) {
      expect(toolIndex.search(word).map(match => match.tool.id), word).toContain('part:bridge');
    }
    entry.run();
    expect(service.isActive).toBe(true);
    expect(entry.isActive!()).toBe(true);
  });
});

describe('the Bridge dialog — picking the ends', () => {
  it('opens with From armed on edges and vertices, and hands the border to an empty To on From\'s first pick', async () => {
    const rig = mount();
    rig.service.enter();
    const panel = rig.service.dialogPanel;
    expect(panel.armedRow).toBe('from');
    expect(rig.channels).toMatchObject({ pickFilter: 'edge', pickVertices: true, pickSketchWires: false });
    expect(rig.service.isHoverPicking).toBe(true);
    expect(rig.continuity('from')).toBe('Tangent');
    expect(rig.continuity('to')).toBe('Tangent');
    expect(rig.magnitudeInput('from').value).toBe('1');

    await rig.pickEdgeEnd(edge(3), BOX[5]);
    expect(rig.chips('from')).toEqual(['Edge end']);
    expect(panel.armedRow).toBe('to');

    await rig.pickEdgeEnd(edge(0, 'pc-wire'), RAIL[0]);
    expect(rig.chips('to')).toEqual(['Curve edge start']);
    // To holds a pick: it keeps the border for a re-pick.
    expect(panel.armedRow).toBe('to');

    // Back on From, To holding an end: From keeps the border, its pick replaced.
    rig.armEnd('from');
    await rig.pickEdgeEnd(edge(3), BOX[4]);
    expect(rig.chips('from')).toEqual(['Edge start']);
    expect(panel.armedRow).toBe('from');
  });

  it('floats the hovered edge\'s nearer end, asked as a hole asks — start and end only — and takes the end nearest the click', async () => {
    const rig = mount();
    rig.service.enter();
    const { x, y } = screen(BOX[4]);
    rig.service.handleHover('box-solid', edge(3).sub, x + 2, y);
    await vi.advanceTimersByTimeAsync(150);
    expect(server.bodies('api/selection/connector-anchors')).toEqual([{ entity: edge(3), purpose: 'hole', frames: true }]);

    // Near the middle the nearer end still wins: the centre is not an end.
    const middle = screen([21, 0, 10]);
    rig.service.handleHover('box-solid', edge(3).sub, middle.x, middle.y);
    rig.service.handleClick('box-solid', edge(3).sub);
    await vi.advanceTimersByTimeAsync(0);
    expect(rig.chips('from')).toEqual(['Edge end']);
  });

  it('takes an edge end of a solid and of a curve as that edge\'s start or end, lit with the dot at its end', async () => {
    server.routes.set('api/feature-ghost', () => CURVE);
    const rig = mount();
    await pickEnds(rig);
    expect(rig.highlights.at(-1)!.entities).toEqual([
      edge(3), { shapeId: 'box-solid', sub: { type: 'vertex', index: 5, position: { x: 40, y: 0, z: 10 } } },
      edge(0, 'pc-wire'), { shapeId: 'pc-wire', sub: { type: 'vertex', index: 0, position: { x: -30, y: 0, z: 5 } } },
    ]);
    await vi.advanceTimersByTimeAsync(300);
    expect(sent('api/feature-ghost')).toEqual([{ feature: 'bridge', from: BOX_END, to: RAIL_START, ...DEFAULTS }]);
  });

  it('takes a sketch edge\'s end as the vertex at that end, keeping the continuity', async () => {
    const rig = mount();
    rig.service.enter();
    await rig.pickEdgeEnd(edge(3), BOX[5]);
    rig.chooseContinuity('to', 'Curvature');
    await rig.pickEdgeEnd(edge(0, 'l1-edge'), LINE[1]);
    expect(rig.chips('to')).toEqual(['Sketch edge end']);
    expect(rig.continuity('to')).toBe('Curvature');
    expect(rig.muted('to')).toEqual([]);
    rig.apply();
    await vi.advanceTimersByTimeAsync(0);
    expect(applies()).toEqual([{
      feature: 'bridge', from: BOX_END, to: { kind: 'vertex', shapeId: 'l1-edge', index: 1 }, ...DEFAULTS, endContinuity: 'g2',
    }]);
  });

  it('meets a corner of a solid at its position only: Position locked with its hint and the magnitude hidden, the choice back once the end is another', async () => {
    const rig = mount();
    rig.service.enter();
    rig.chooseContinuity('from', 'Curvature');
    await rig.pickVertex('box-solid', 6, BOX[6]);
    expect(rig.chips('from')).toEqual(['Corner']);
    expect(rig.continuity('from')).toBe('Position');
    expect(rig.muted('from')).toEqual(['Tangent', 'Curvature']);
    expect(rig.hint('from').textContent).toBe(POSITION_ONLY_HINT.corner);
    expect(rig.hint('from').classList.contains('hidden')).toBe(false);
    expect(rig.magnitudeRow('from').classList.contains('hidden')).toBe(true);
    // A muted tab takes no click.
    rig.chooseContinuity('from', 'Tangent');
    expect(rig.continuity('from')).toBe('Position');
    // To is untouched.
    expect(rig.continuity('to')).toBe('Tangent');
    expect(rig.magnitudeRow('to').classList.contains('hidden')).toBe(false);

    // Re-picked as an edge's end, From is back on the user's Curvature.
    rig.armEnd('from');
    await rig.pickEdgeEnd(edge(3), BOX[5]);
    expect(rig.continuity('from')).toBe('Curvature');
    expect(rig.muted('from')).toEqual([]);
    expect(rig.hint('from').classList.contains('hidden')).toBe(true);
    expect(rig.magnitudeRow('from').classList.contains('hidden')).toBe(false);

    // The chip's ✕ lets go of a corner too. (From's pick handed the border to the empty To.)
    expect(rig.service.dialogPanel.armedRow).toBe('to');
    rig.armEnd('from');
    await rig.pickVertex('box-solid', 6, BOX[6]);
    expect(rig.continuity('from')).toBe('Position');
    rig.panel().querySelector<HTMLElement>('[data-role="from-slot"] button')!.click();
    expect(rig.chips('from')).toEqual([]);
    expect(rig.continuity('from')).toBe('Curvature');
  });

  it('meets a sketch point at its position only, and sends a corner\'s end as g0', async () => {
    const rig = mount();
    rig.service.enter();
    await rig.pickVertex('p1-vertex', 0, POINT);
    expect(rig.chips('from')).toEqual(['Point']);
    expect(rig.continuity('from')).toBe('Position');
    expect(rig.hint('from').textContent).toBe(POSITION_ONLY_HINT.point);
    await rig.pickVertex('box-solid', 6, BOX[6]);
    expect(rig.chips('to')).toEqual(['Corner']);
    rig.apply();
    await vi.advanceTimersByTimeAsync(0);
    expect(applies()).toEqual([{
      feature: 'bridge',
      from: { kind: 'vertex', shapeId: 'p1-vertex', index: 0 },
      to: { kind: 'vertex', shapeId: 'box-solid', index: 6 },
      startContinuity: 'g0', endContinuity: 'g0', startMagnitude: 1, endMagnitude: 1,
    }]);
  });

  it('refuses the end the other row already holds, a closed edge, a timeline row and a point nothing names', async () => {
    const rig = mount();
    rig.service.enter();
    await rig.pickEdgeEnd(edge(3), BOX[5]);
    await rig.pickEdgeEnd(edge(3), BOX[5]);
    expect(rig.message()).toBe('The bridge already starts there — pick another end.');
    expect(rig.chips('to')).toEqual([]);
    expect(rig.service.dialogPanel.armedRow).toBe('to');

    await rig.pickEdgeEnd(edge(0, 'ring-wire'), [0, 0, 0]);
    expect(rig.message()).toBe(CLOSED_EDGE_REFUSAL);
    expect(rig.chips('to')).toEqual([]);

    expect(rig.service.handleTimelinePick(rowOf('pc'))).toBe(true);
    expect(rig.message()).toBe('Projected Curve 1 gives no end — pick near the end of an edge or a curve, or a point, in the viewport.');

    await rig.pickVertex('nowhere', 0, [0, 0, 0]);
    expect(rig.message()).toBe('That point cannot be an end — pick a corner, a point, or near the end of an edge.');
    expect(rig.chips('to')).toEqual([]);
  });

  it('grows nothing on a double-click and opens no menu on a right-click', async () => {
    const rig = mount();
    rig.service.enter();
    await rig.pickEdgeEnd(edge(3), BOX[5]);
    const asked = server.requests.length;
    await rig.service.handleDoubleClick('box-solid', edge(3).sub);
    rig.service.handleContextMenu('box-solid', edge(3).sub, 10, 10);
    await vi.advanceTimersByTimeAsync(0);
    expect(server.requests.slice(asked).map(request => request.route))
      .not.toEqual(expect.arrayContaining(['api/selection/expand-loop', 'api/selection/expand-bucket', 'api/selection/groups']));
    expect(rig.container.querySelector('#fluidcad-bridge-select-menu button')).toBeNull();
    expect(rig.chips('from')).toEqual(['Edge end']);
    expect(rig.chips('to')).toEqual([]);
  });
});

describe('the Bridge dialog — options, preview and apply', () => {
  it('previews nothing until both ends hold a pick, then sends each end\'s continuity and magnitude, the curve drawn as a wire', async () => {
    server.routes.set('api/feature-ghost', () => CURVE);
    const set = vi.spyOn(FeatureGhostOverlay.prototype, 'set').mockImplementation(() => {});
    const rig = mount();
    rig.service.enter();
    await rig.pickEdgeEnd(edge(3), BOX[5]);
    await vi.advanceTimersByTimeAsync(300);
    expect(server.count('api/feature-ghost')).toBe(0);
    expect(server.count('api/apply-feature')).toBe(0);

    await rig.pickEdgeEnd(edge(0, 'pc-wire'), RAIL[0]);
    await vi.advanceTimersByTimeAsync(300);
    expect(sent('api/apply-feature')).toEqual([{ feature: 'bridge', from: BOX_END, to: RAIL_START, ...DEFAULTS, preview: true }]);
    expect(sent('api/feature-ghost')).toEqual([{ feature: 'bridge', from: BOX_END, to: RAIL_START, ...DEFAULTS }]);
    expect(set).toHaveBeenLastCalledWith(CURVE.solids, 'wire');

    // Each end on its own: From at Curvature, a fuller To.
    rig.chooseContinuity('from', 'Curvature');
    await vi.advanceTimersByTimeAsync(300);
    expect(sent('api/feature-ghost').at(-1)).toEqual({ feature: 'bridge', from: BOX_END, to: RAIL_START, ...DEFAULTS, startContinuity: 'g2' });
    rig.typeMagnitude('to', '2.5');
    await vi.advanceTimersByTimeAsync(300);
    expect(sent('api/feature-ghost').at(-1)).toMatchObject({ startContinuity: 'g2', endContinuity: 'g1', endMagnitude: 2.5 });

    // To at Position: its magnitude hides, and stands as 1.
    rig.chooseContinuity('to', 'Position');
    expect(rig.magnitudeRow('to').classList.contains('hidden')).toBe(true);
    await vi.advanceTimersByTimeAsync(300);
    expect(sent('api/feature-ghost').at(-1)).toEqual({
      feature: 'bridge', from: BOX_END, to: RAIL_START, startContinuity: 'g2', endContinuity: 'g0', startMagnitude: 1, endMagnitude: 1,
    });

    rig.typeMagnitude('from', '0.5');
    rig.apply();
    await vi.advanceTimersByTimeAsync(0);
    expect(applies()).toEqual([{
      feature: 'bridge', from: BOX_END, to: RAIL_START, startContinuity: 'g2', endContinuity: 'g0', startMagnitude: 0.5, endMagnitude: 1,
    }]);
    expect(rig.service.isActive).toBe(false);
  });

  it('previews nothing while a magnitude on show does not read or is not above zero, and Apply says so; a hidden one is not read', async () => {
    server.routes.set('api/feature-ghost', () => CURVE);
    const rig = mount();
    await pickEnds(rig);
    rig.typeMagnitude('from', '0');
    await vi.advanceTimersByTimeAsync(300);
    rig.typeMagnitude('from', '');
    await vi.advanceTimersByTimeAsync(300);
    expect(server.count('api/feature-ghost')).toBe(0);
    expect(server.count('api/apply-feature')).toBe(0);
    rig.apply();
    await vi.advanceTimersByTimeAsync(0);
    expect(rig.message()).toBe('Enter a magnitude at the From end.');
    rig.typeMagnitude('from', '-1');
    rig.apply();
    await vi.advanceTimersByTimeAsync(0);
    expect(rig.message()).toBe('Enter a magnitude greater than zero at the From end.');
    rig.typeMagnitude('from', 'class = 3');
    rig.apply();
    await vi.advanceTimersByTimeAsync(0);
    expect(rig.message()).toBe("Enter a valid magnitude at the From end — 'class' is not a valid name.");
    expect(applies()).toEqual([]);

    // Met at Position, the field is not read: the preview goes ahead.
    rig.chooseContinuity('from', 'Position');
    await vi.advanceTimersByTimeAsync(300);
    expect(sent('api/feature-ghost')).toEqual([{ feature: 'bridge', from: BOX_END, to: RAIL_START, ...DEFAULTS, startContinuity: 'g0' }]);
  });

  it('reads an expression magnitude where the statement lands, and writes a new name\'s declaration with it', async () => {
    const PART = { filePath: FILE, line: 1, column: 0 };
    setActivePartProvider(() => PART);
    server.routes.set('api/scope-variables', () => ({ variables: [{ name: 'full', initializer: '2', numeric: true }] }));
    server.routes.set('api/feature-ghost', () => CURVE);
    const rig = mount();
    await pickEnds(rig);
    expect(server.bodies('api/scope-variables')).toEqual([{ sketchSourceLine: null, part: PART }]);
    await vi.advanceTimersByTimeAsync(0);
    rig.typeMagnitude('to', 'full * 2');
    await vi.advanceTimersByTimeAsync(300);
    expect(server.bodies('api/feature-ghost').at(-1)).toMatchObject({ endMagnitude: 'full * 2', valueScope: { kind: 'append', ...PART } });

    rig.typeMagnitude('from', 'tight = 0.4');
    rig.apply();
    await vi.advanceTimersByTimeAsync(0);
    expect(applies()).toEqual([{
      feature: 'bridge', from: BOX_END, to: RAIL_START, startContinuity: 'g1', endContinuity: 'g1',
      startMagnitude: 'tight', endMagnitude: 'full * 2',
      newVariables: [{ name: 'tight', initializer: expect.stringContaining('0.4') }],
    }]);
  });

  it('shows the engine\'s refusal in the dialog', async () => {
    server.routes.set('api/feature-ghost', () => ({ success: false, surface: true, reason: 'bridge: the two ends are at the same point.' }));
    const rig = mount();
    await pickEnds(rig);
    await vi.advanceTimersByTimeAsync(300);
    expect(rig.message()).toBe('bridge: the two ends are at the same point.');
    // A change clears it; the next answer says its own.
    rig.typeMagnitude('to', '2');
    expect(rig.message()).toBe('');
  });

  it('refuses an Apply with an end empty', async () => {
    const rig = mount();
    rig.service.enter();
    rig.apply();
    await vi.advanceTimersByTimeAsync(0);
    expect(rig.message()).toBe('Pick where the bridge starts: near the end of an edge or a curve, or a point.');
    await rig.pickEdgeEnd(edge(3), BOX[5]);
    rig.apply();
    await vi.advanceTimersByTimeAsync(0);
    expect(rig.message()).toBe('Pick where the bridge ends: near the end of an edge or a curve, or a point.');
    expect(applies()).toEqual([]);
  });

  it('drops a picked end when a render re-mints the ids', async () => {
    const rig = mount();
    await pickEnds(rig);
    rig.service.update(scene());
    expect(rig.chips('from')).toEqual([]);
    expect(rig.chips('to')).toEqual([]);
  });
});

describe('editing a bridge', () => {
  const TARGET: FeatureEditTarget = at(10);
  const PARSED = {
    feature: 'bridge',
    fromText: 'e.sideEdges(2).end()',
    toText: 'pc.start()',
    fromRef: null,
    toRef: null,
    startContinuity: 'g2',
    endContinuity: 'g1',
    startMagnitude: 1.5,
    endMagnitude: 1,
    startMagnitudeArg: '1.5',
    endMagnitudeArg: null,
  } as ParsedFeatureOf<'bridge'>;
  // The bridge is the scene's seventh row: the session rolls back to just before it.
  const INFO = { index: 6, type: 'bridge', expectedStatement: "bridge(e.sideEdges(2).end(), pc.start()).continuity('g2', 'g1').startMagnitude(1.5).name('Bridge 1')" };
  const BOUNDARY = { index: 6, type: 'bridge', line: 10, column: 0 };
  const EDIT = { feature: 'bridge', edit: TARGET, expectedStatement: INFO.expectedStatement };
  const KEPT_FROM = { kind: 'edge-end', shapeId: 'box-solid', index: 3, end: 'end' };
  const KEPT_TO = { kind: 'curve-end', filePath: FILE, line: 4, end: 'start' };

  /** Open the dialog over the bridge, the engine resolving both ends, and land at the boundary. */
  async function openEdit(parsed: Partial<typeof PARSED> = {}) {
    server.routes.set('api/feature/sources', () => ({
      ok: true,
      feature: 'bridge',
      from: { kind: 'edge-end', entity: edge(3), end: 'end' },
      to: { kind: 'curve-end', ...at(4, 10), end: 'start' },
    }));
    server.routes.set('api/feature-ghost', () => CURVE);
    const rig = mount(scene(true));
    rig.service.enterEdit(TARGET, { ...PARSED, ...parsed }, INFO);
    await vi.advanceTimersByTimeAsync(0);
    rig.service.handleSceneRendered(scene(true), 5, true);
    await vi.advanceTimersByTimeAsync(300);
    return rig;
  }

  it('reopens on both ends as Current chips lit as the engine resolved them, each continuity and magnitude as written', async () => {
    const rig = await openEdit();
    expect(rig.panel().textContent).toContain('Edit bridge');
    expect(rig.chips('from')).toEqual(['Current: e.sideEdges(2).end()']);
    expect(rig.chips('to')).toEqual(['Current: pc.start()']);
    expect(rig.continuity('from')).toBe('Curvature');
    expect(rig.continuity('to')).toBe('Tangent');
    expect(rig.magnitudeInput('from').value).toBe('1.5');
    expect(rig.magnitudeInput('to').value).toBe('1');
    expect(rig.service.dialogPanel.armedRow).toBe('from');
    expect(server.bodies('api/feature/sources')).toEqual([{ before: BOUNDARY }]);
    expect(server.bodies('api/scope-variables').at(-1)).toEqual({ sketchSourceLine: 10 });
    expect(rig.highlights.at(-1)).toMatchObject({ entities: [edge(3)], wireIds: ['pc-wire'] });
    expect(server.bodies('api/feature-ghost').at(-1)).toEqual({
      feature: 'bridge', from: KEPT_FROM, to: KEPT_TO,
      startContinuity: 'g2', endContinuity: 'g1', startMagnitude: 1.5, endMagnitude: 1,
      valueScope: { kind: 'statement', ...TARGET },
    });
  });

  it('opens an end met at Position with its magnitude hidden, and an end kept as written opaque with no preview', async () => {
    server.routes.set('api/feature/sources', () => ({ ok: true, feature: 'bridge', from: { kind: 'opaque' }, to: { kind: 'opaque' } }));
    server.routes.set('api/feature-ghost', () => CURVE);
    const rig = mount(scene(true));
    rig.service.enterEdit(TARGET, { ...PARSED, fromText: 'sk.geometries.p1', endContinuity: 'g0' }, INFO);
    await vi.advanceTimersByTimeAsync(0);
    rig.service.handleSceneRendered(scene(true), 5, true);
    await vi.advanceTimersByTimeAsync(300);
    expect(rig.chips('from')).toEqual(['Current: sk.geometries.p1']);
    expect(rig.continuity('to')).toBe('Position');
    // Nothing locks it: what the statement says, it may change.
    expect(rig.muted('to')).toEqual([]);
    expect(rig.magnitudeRow('to').classList.contains('hidden')).toBe(true);
    expect(server.count('api/feature-ghost')).toBe(0);
  });

  it('applies an untouched edit with nothing but the statement', async () => {
    const rig = await openEdit();
    rig.apply();
    await vi.advanceTimersByTimeAsync(0);
    expect(applies()).toEqual([EDIT]);
    expect(rig.service.isActive).toBe(false);
  });

  it('sends only the magnitude when only a magnitude changed, the ends and the continuities written back as they were', async () => {
    const rig = await openEdit();
    rig.typeMagnitude('from', '0.5');
    await vi.advanceTimersByTimeAsync(300);
    expect(sent('api/apply-feature').at(-1)).toEqual({ ...EDIT, startMagnitude: 0.5, preview: true });
    expect(sent('api/feature-ghost').at(-1)).toMatchObject({ startMagnitude: 0.5 });
    rig.apply();
    await vi.advanceTimersByTimeAsync(0);
    expect(applies().at(-1)).toEqual({ ...EDIT, startMagnitude: 0.5 });
  });

  it('sends only the continuity when only a continuity changed — a magnitude at an end met at Position never', async () => {
    const rig = await openEdit();
    rig.chooseContinuity('to', 'Position');
    rig.apply();
    await vi.advanceTimersByTimeAsync(0);
    expect(applies().at(-1)).toEqual({ ...EDIT, endContinuity: 'g0' });

    // The field a Position end hides is not read, nor sent, whatever it holds.
    const hidden = await openEdit({ endContinuity: 'g0' });
    hidden.chooseContinuity('from', 'Tangent');
    hidden.apply();
    await vi.advanceTimersByTimeAsync(0);
    expect(applies().at(-1)).toEqual({ ...EDIT, startContinuity: 'g1' });
  });

  it('keeps an expression magnitude as written, and sends a new one with the declaration it commits', async () => {
    const kept = await openEdit({ startMagnitude: 'full / 2', startMagnitudeArg: 'full / 2' });
    expect(kept.magnitudeInput('from').value).toBe('full / 2');
    expect(sent('api/feature-ghost').at(-1)).toMatchObject({ startMagnitude: 'full / 2' });
    kept.apply();
    await vi.advanceTimersByTimeAsync(0);
    expect(applies().at(-1)).toEqual(EDIT);

    const declared = await openEdit();
    declared.typeMagnitude('to', 'loose = 3');
    declared.apply();
    await vi.advanceTimersByTimeAsync(0);
    expect(applies().at(-1)).toEqual({
      ...EDIT, endMagnitude: 'loose', newVariables: [{ name: 'loose', initializer: expect.stringContaining('3') }],
    });
  });

  it('rewrites only the re-picked end, with the boundary, the other kept as written', async () => {
    const rig = await openEdit();
    rig.armEnd('to');
    await rig.pickEdgeEnd(edge(9), BOX[6]);
    expect(rig.chips('to')).toEqual(['Edge end']);
    expect(rig.chips('from')).toEqual(['Current: e.sideEdges(2).end()']);
    await vi.advanceTimersByTimeAsync(300);
    // The kept From stands in the preview as the engine resolved it.
    expect(sent('api/feature-ghost').at(-1)).toMatchObject({ from: KEPT_FROM, to: { kind: 'edge-end', shapeId: 'box-solid', index: 9, end: 'end' } });
    rig.apply();
    await vi.advanceTimersByTimeAsync(0);
    expect(applies().at(-1)).toEqual({ ...EDIT, before: BOUNDARY, to: { kind: 'edge-end', shapeId: 'box-solid', index: 9, end: 'end' } });

    // A corner re-picked: its end is met at Position, which the edit says.
    const corner = await openEdit();
    corner.armEnd('to');
    await corner.pickVertex('box-solid', 6, BOX[6]);
    corner.apply();
    await vi.advanceTimersByTimeAsync(0);
    expect(applies().at(-1)).toEqual({
      ...EDIT, before: BOUNDARY, to: { kind: 'vertex', shapeId: 'box-solid', index: 6 }, endContinuity: 'g0',
    });
  });

  it('says the re-picked ends were reset when the code changes under the edit', async () => {
    const rig = await openEdit();
    rig.armEnd('to');
    await rig.pickEdgeEnd(edge(9), BOX[6]);
    // A full render mid-session, then the boundary again.
    rig.service.handleSceneRendered(scene(true), 6, false);
    rig.service.handleSceneRendered(scene(true), 5, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(rig.message()).toBe('The code changed — the re-picked ends were reset.');
    expect(rig.chips('to')).toEqual(['Current: pc.start()']);
  });

  it('opens from a bridge row through the registry', async () => {
    server.routes.set('api/feature/sources', () => ({ ok: true, feature: 'bridge', from: { kind: 'opaque' }, to: { kind: 'opaque' } }));
    const rig = mount(scene(true));
    const registry = new FeatureDialogRegistry();
    // Every other dialog a stand-in that is never open: only the routing is read.
    const idle = { isActive: false, isEditing: false, isPicking: false, sketchUISuspended: false, exit: () => {}, handleSceneRendered: () => {} };
    const others = new Proxy({} as Record<string, unknown>, { get: (_target, key) => key === 'bridge' ? rig.service : idle });
    PartFeatureDialogs.register(registry, others as unknown as PartDialogServices);

    expect(registry.editsRowType('bridge')).toBe(true);
    const dialog = registry.forStatement(PARSED)!;
    expect(dialog.id).toBe('bridge');
    dialog.enterEdit!(TARGET, PARSED, INFO, rowOf('br'));
    expect(rig.service.isEditing).toBe(true);
    expect(rig.chips('from')).toEqual(['Current: e.sideEdges(2).end()']);

    // Armed, the hover reaches it through the registry, and a click too.
    expect(registry.routeHover('box-solid', edge(3).sub, 1, 2)).toBe(true);
    expect(registry.routeClick('box-solid', edge(3).sub)).toBe(true);
  });
});
