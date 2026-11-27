// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PerspectiveCamera, Scene } from 'three';
import type { SelectionGroup } from '../src/api';
import { OperandSlotControl } from '../src/interactive/create-feature/operand-slot';
import { ProjectionPickService } from '../src/interactive/projection-pick-service';
import { SelectionContextMenu } from '../src/interactive/selection-menu';
import { MeasureController } from '../src/ui/measure/measure-controller';
import type { SceneObjectRender } from '../src/types';
import type { SelectedEntity, Viewer } from '../src/viewer';
import { FakeSelectionServer } from './fixtures/fake-selection-server';

// Loops in the pickers no other test file covers (surface step 09): the
// Project tool's right-click menu offers the loop groups and keeps the one
// chosen as a chain sent with `kind: 'loop'`, as it keeps a tangent chain,
// and its double-click keeps a surface's rim loop the same way; neutral
// mode's measure selection takes a loop group's members as plain picks; and
// an operand row (the curve and surface tools' pick list) grows by a
// double-click or a group's members as plain picks. The fillet dialog's are
// in modify-pick-loops.test.ts; the colour dialog's, the sweep path's and a
// custom feature's in their own dialogs' test files, since the shared
// worker binds a dialog service to the first test file's api mock. The
// services here talk to a stubbed network (FakeSelectionServer).

beforeAll(() => {
  // jsdom has no ResizeObserver/rAF; the toolbar only measures with them.
  (globalThis as any).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  (globalThis as any).requestAnimationFrame ??= (cb: () => void) => setTimeout(cb, 0);
  (globalThis as any).cancelAnimationFrame ??= (id: number) => clearTimeout(id);
});

let server: FakeSelectionServer;

beforeEach(() => {
  vi.useFakeTimers();
  server = new FakeSelectionServer().install();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

const FILE = '/ws/m.fluid.js';
const at = (line: number, column = 0) => ({ filePath: FILE, line, column });
const MESH = [{ vertices: [0, 0, 0, 1, 0, 0], normals: [], indices: [0, 1] }];
const edge = (index: number, shapeId = 'block-solid'): SelectedEntity => ({ shapeId, sub: { type: 'edge', index } });
const face = (index: number, shapeId = 'block-solid'): SelectedEntity => ({ shapeId, sub: { type: 'face', index } });

/** A sketch, a block, and a surface loaded from a file. */
function scene(): SceneObjectRender[] {
  return [
    { id: 'sk', type: 'sketch', name: 'Sketch 1', isContainer: true, sceneShapes: [], ownShapes: [], sourceLocation: at(2) },
    {
      id: 'ring', type: 'circle', parentId: 'sk', ownShapes: [], sourceLocation: at(3),
      sceneShapes: [{ shapeId: 'ring-wire', shapeType: 'edge', meshes: MESH }],
    },
    {
      id: 'block', type: 'extrude', name: 'Extrude 1', ownShapes: [], sourceLocation: at(5),
      sceneShapes: [{ shapeId: 'block-solid', shapeType: 'solid', meshes: MESH }],
    },
    {
      id: 'sheet', type: 'load', name: 'Load 1', ownShapes: [], sourceLocation: at(6),
      sceneShapes: [{ shapeId: 'sheet', shapeType: 'surface', meshes: MESH }],
    },
  ] as unknown as SceneObjectRender[];
}

/** A viewer that records the highlight; every other call is a no-op. */
function stubViewer(objects: SceneObjectRender[] = scene()) {
  const highlights: SelectedEntity[][] = [];
  const base: Record<string, unknown> = {
    pickFilter: 'all',
    pickSketchWires: false,
    pickAxes: false,
    pickPlanes: false,
    pickVertices: false,
    sceneIsEmpty: false,
    missedSketchRender: false,
    isRegionPicking: false,
    isSketchMode: false,
    currentSceneObjects: objects,
    sceneContext: {
      scene: new Scene(),
      renderer: { domElement: document.createElement('canvas') },
      camera: new PerspectiveCamera(),
      requestRender: () => {},
    },
    highlightEntities: (entities: SelectedEntity[]) => highlights.push(entities),
    clearHighlight: () => highlights.push([]),
  };
  const viewer = new Proxy(base, {
    get: (target, key) => (key in target ? target[key as string] : () => () => {}),
    set: (target, key, value) => {
      target[key as string] = value;
      return true;
    },
  }) as unknown as Viewer;
  return { viewer, highlights };
}

/** Answer the next right-click with these groups, open the menu, and read its items. */
async function menuOf(container: HTMLElement, id: string, groups: SelectionGroup[], open: () => void) {
  server.groups = groups;
  open();
  await vi.advanceTimersByTimeAsync(0);
  return [...container.querySelectorAll<HTMLButtonElement>(`#${id} button`)];
}

/** The viewer's double-click on a pick: its two clicks land first, toggling the pick on and off again. */
async function doubleClick(
  service: { handleClick(shapeId: string, sub: SelectedEntity['sub']): unknown; handleDoubleClick(shapeId: string, sub: SelectedEntity['sub']): unknown },
  entity: SelectedEntity,
): Promise<void> {
  service.handleClick(entity.shapeId, entity.sub);
  service.handleClick(entity.shapeId, entity.sub);
  await service.handleDoubleClick(entity.shapeId, entity.sub);
  await vi.advanceTimersByTimeAsync(0);
}

const choose = (items: HTMLButtonElement[], label: string) => items.find(b => b.textContent === label)!.click();
const labels = (items: HTMLButtonElement[]) => items.map(b => b.textContent);

const RIM = [edge(1, 'sheet'), edge(2, 'sheet'), edge(5, 'sheet')];
const FACE_LOOP = [edge(0), edge(1), edge(2), edge(3)];
const SIDE_LOOP = [edge(0), edge(4), edge(5), edge(6)];
const EDGE_GROUPS: SelectionGroup[] = [
  { kind: 'tangent', label: 'Tangent Edges', members: [edge(0), edge(1)] },
  { kind: 'loop', label: 'Outer Loop of Plane 1', members: FACE_LOOP },
  { kind: 'loop', label: 'Outer Loop of Plane 2', members: SIDE_LOOP },
  { kind: 'same-type', label: 'All Lines', members: [edge(0), edge(1), edge(2)] },
];

describe('the Project tool', () => {
  function mount() {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const { viewer } = stubViewer();
    const service = new ProjectionPickService(container, viewer);
    service.handleSceneRendered(scene(), 0, false);
    service.enter(at(2));
    /** The last statement preview the tool asked for. */
    const lastProject = async () => {
      await vi.advanceTimersByTimeAsync(400);
      return server.bodies('api/apply-feature').filter(body => body.feature === 'project').at(-1);
    };
    return { container, service, lastProject };
  }

  it('offers the loop groups and keeps the one chosen as a chain sent as a loop', async () => {
    const { container, service, lastProject } = mount();
    const items = await menuOf(container, 'fluidcad-projection-pick-menu', EDGE_GROUPS,
      () => service.handleContextMenu('block-solid', edge(1).sub, 10, 10));
    expect(labels(items)).toEqual(['Tangent Edges (2)', 'Outer Loop of Plane 1 (4)', 'Outer Loop of Plane 2 (4)', 'All Lines (3)']);
    choose(items, 'Outer Loop of Plane 2 (4)');
    const body = await lastProject();
    expect(body.entities).toEqual(SIDE_LOOP);
    expect(body.chains).toEqual([{ seed: edge(1), members: SIDE_LOOP, kind: 'loop' }]);
    service.exit();
  });

  it('takes a surface\'s rim loop on a double-click, and any other edge\'s bucket', async () => {
    const { service, lastProject } = mount();
    server.loop = (entity) => entity.shapeId === 'sheet' ? { rim: true, members: RIM } : { rim: false, members: [] };
    server.bucket = () => ({ members: [edge(7), edge(8)] });
    await doubleClick(service, edge(2, 'sheet'));
    const loop = await lastProject();
    expect(loop.entities).toEqual(RIM);
    // Kept whole, as the menu's Boundary Loop is: written as the loop.
    expect(loop.chains).toEqual([{ seed: edge(2, 'sheet'), members: RIM, kind: 'loop' }]);
    expect(server.count('api/selection/expand-bucket')).toBe(0);

    await doubleClick(service, edge(7));
    const body = await lastProject();
    expect(body.entities).toEqual([...RIM, edge(7), edge(8)]);
    expect(body.chains).toEqual(loop.chains);
    service.exit();
  });
});

describe('the neutral-mode measure selection', () => {
  it('offers the loop groups and takes the one chosen as plain picks', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const { viewer } = stubViewer();
    const client = new Proxy({}, { get: () => () => new Promise(() => {}) });
    const controller = new MeasureController(container, client as never, viewer,
      (handlers) => new SelectionContextMenu(container, 'test-measure-menu', handlers));
    const items = await menuOf(container, 'test-measure-menu', [
      { kind: 'loop', label: 'Boundary Loop', members: RIM },
      ...EDGE_GROUPS,
    ], () => controller.handleContextMenu('sheet', edge(2, 'sheet').sub, 10, 10));
    expect(labels(items)).toEqual([
      'Boundary Loop (3)', 'Tangent Edges (2)', 'Outer Loop of Plane 1 (4)', 'Outer Loop of Plane 2 (4)', 'All Lines (3)',
    ]);
    choose(items, 'Boundary Loop (3)');
    expect(controller.selection).toEqual(RIM);
  });
});

describe('an operand row', () => {
  function mount(kind: 'curve' | 'surface', multiple = true) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const control = new OperandSlotControl(host, {
      kind, label: kind === 'curve' ? 'Edges' : 'Faces', prompt: 'Pick', multiple,
    });
    control.setScene(scene());
    const sent = () => {
      const picks = control.picks();
      return 'keep' in picks ? 'keep' : picks.entities;
    };
    return { control, sent };
  }

  it('takes a surface\'s rim loop on a double-click, a loaded surface having no bucket', async () => {
    const { control, sent } = mount('curve');
    server.loop = () => ({ rim: true, members: RIM });
    expect(await control.takeDoubleClick('sheet', edge(2, 'sheet').sub)).toBe('taken');
    expect(sent()).toEqual(RIM);
  });

  it('expands a solid\'s edge or face to its bucket, and passes a refusal on', async () => {
    const curves = mount('curve');
    server.bucket = () => ({ members: [edge(7), edge(8)] });
    expect(await curves.control.takeDoubleClick('block-solid', edge(7).sub)).toBe('taken');
    expect(curves.sent()).toEqual([edge(7), edge(8)]);

    const faces = mount('surface');
    server.bucket = (entity) => entity.sub.index === 1 ? { members: [face(1), face(2)] } : { error: 'no bucket member survives on the current bodies' };
    const asked = server.count('api/selection/expand-loop');
    expect(await faces.control.takeDoubleClick('block-solid', face(1).sub)).toBe('taken');
    expect(faces.sent()).toEqual([face(1), face(2)]);
    expect(server.count('api/selection/expand-loop')).toBe(asked);
    expect(await faces.control.takeDoubleClick('block-solid', face(3).sub)).toEqual({ message: 'no bucket member survives on the current bodies' });
  });

  it('grows nothing that stands for a whole object, nor a single slot', async () => {
    const curves = mount('curve');
    expect(await curves.control.takeDoubleClick('ring-wire', edge(0, 'ring-wire').sub)).toBe('ignored');
    const surfaces = mount('surface');
    expect(await surfaces.control.takeDoubleClick('sheet', face(0, 'sheet').sub)).toBe('ignored');
    const single = mount('curve', false);
    expect(await single.control.takeDoubleClick('sheet', edge(2, 'sheet').sub)).toBe('ignored');
    expect(server.count('api/selection/expand-loop') + server.count('api/selection/expand-bucket')).toBe(0);
  });

  it('takes a right-click group\'s members as plain picks, keeping what it holds', () => {
    const { control, sent } = mount('curve');
    control.takeClick('block-solid', edge(1).sub);
    expect(control.takeMembers(FACE_LOOP)).toBe('taken');
    expect(sent()).toEqual([edge(1), edge(0), edge(2), edge(3)]);
    expect(control.takeMembers(FACE_LOOP)).toBe('ignored');
  });
});
