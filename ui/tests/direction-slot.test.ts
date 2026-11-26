// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DirectionSlotControl, type DirectionGeometry } from '../src/interactive/create-feature/direction-slot';
import type { SceneObjectRender, SubSelection } from '../src/types';
import type { SelectedEntity } from '../src/viewer';

// A direction is given as an axis is given everywhere else, or as a plane,
// which stands for its normal. The row takes a world axis, an axis() line, a
// straight edge, a connector, an origin plane, a plane() quad or a planar
// face — and refuses a curved edge or face, which gives no direction. What
// it reports names one kind per kind of the server's direction spec.

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

const FILE = '/ws/m.part.js';
const at = (line: number, column = 2) => ({ filePath: FILE, line, column });
const MESH = [{ vertices: [0, 0, 0, 1, 0, 0], normals: [], indices: [0, 1] }];

const FRAME = {
  origin: { x: 30, y: 0, z: 10 },
  xDirection: { x: 1, y: 0, z: 0 },
  yDirection: { x: 0, y: 1, z: 0 },
  normal: { x: 0, y: 0, z: 1 },
};

/** A block, an axis and a plane statement, a connector and a copy of it. `mint` re-mints the ids, as a render does. */
function scene(mint = ''): SceneObjectRender[] {
  const id = (name: string) => `${name}${mint}`;
  return [
    {
      id: id('block'), type: 'extrude', name: 'Extrude 1', ownShapes: [], sourceLocation: at(5),
      sceneShapes: [{ shapeId: id('block-solid'), shapeType: 'solid', meshes: MESH }],
    },
    {
      id: id('ax'), type: 'axis', name: 'Axis 1', ownShapes: [], sourceLocation: at(6),
      sceneShapes: [{ shapeId: id('axis-line'), shapeType: 'edge', isMetaShape: true, meshes: MESH }],
    },
    {
      id: id('pl'), type: 'plane', name: 'Plane 1', ownShapes: [], sourceLocation: at(7),
      sceneShapes: [{ shapeId: id('plane-quad'), shapeType: 'face', isMetaShape: true, meshes: MESH }],
    },
    {
      id: id('bolt'), type: 'connector', name: 'bolt', sceneShapes: [], ownShapes: [], sourceLocation: at(8),
      object: { name: 'bolt', ...FRAME },
    },
    {
      id: id('copy'), type: 'copy-linear', name: 'Copy 1', hideChildren: true, sceneShapes: [], ownShapes: [], sourceLocation: at(9),
      object: { connectorCopies: { seeds: [{ id: id('bolt'), name: 'bolt' }], originalSlot: 0, slotCount: 2, slots: [1], connectorsOnly: true } },
    },
    {
      id: id('bolt-1'), type: 'connector', name: 'bolt.instance(1)', parentId: id('copy'), sceneShapes: [], ownShapes: [],
      sourceLocation: at(9), object: { name: 'bolt', ...FRAME, copy: { slot: 1, seedId: id('bolt') } },
    },
  ];
}

const rowOf = (id: string) => scene().find(o => o.id === id)!;
const edge = (index: number): SubSelection => ({ type: 'edge', index });
const face = (index: number): SubSelection => ({ type: 'face', index });
const picked = (type: 'edge' | 'face', index: number, shapeId = 'block-solid'): SelectedEntity => ({ shapeId, sub: { type, index } });

/** The block as the engine knows it: edge 0 straight and edge 1 an arc; face 0 planar and face 1 a cylinder. */
const GEOMETRY: Record<string, DirectionGeometry> = {
  'edge:0': 'straight', 'edge:1': 'curved', 'face:0': 'planar', 'face:1': 'curved',
};

function mount(opts: ConstructorParameters<typeof DirectionSlotControl>[1] = {}) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const asked: string[] = [];
  const control = new DirectionSlotControl(host, {
    classify: async (entity) => {
      const key = `${entity.sub.type}:${entity.sub.index}`;
      asked.push(key);
      return GEOMETRY[key] ?? null;
    },
    ...opts,
  });
  control.setScene(scene());
  const text = () => host.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  const remove = () => [...host.querySelectorAll('button')].find(b => b.textContent === '✕')!.click();
  return { host, control, text, remove, asked };
}

describe('DirectionSlotControl', () => {
  it('asks for the world axes, the origin planes and every pick channel a direction comes through', () => {
    const { control, text } = mount();
    expect(control.channels()).toMatchObject({
      pickFilter: 'all', axes: true, planes: true, standardAxes: true, standardPlanes: true, connectors: true,
      sketchWires: false, vertices: false,
    });
    expect(control.value()).toBeNull();
    expect(text()).toContain('Direction');
    expect(text()).toContain('Pick an axis, an edge, a connector, a plane or a planar face');
  });

  it('accepts a world axis', () => {
    const { control, text } = mount();
    expect(control.takeStandard('y')).toBe('taken');
    expect(control.value()).toEqual({ kind: 'standard', axis: 'y' });
    expect(control.ghost()).toEqual({ kind: 'standard', axis: 'y' });
    expect(control.highlight().standardAxes).toEqual(['y']);
    expect(text()).toContain('World Y axis');
  });

  it('accepts an origin plane, standing for its normal', () => {
    const { control, text } = mount();
    expect(control.takeStandard('xz')).toBe('taken');
    expect(control.value()).toEqual({ kind: 'standard-plane', plane: 'xz' });
    expect(control.ghost()).toEqual({ kind: 'standard-plane', plane: 'xz' });
    expect(text()).toContain('XZ plane');
  });

  it('accepts an axis() line and a plane() quad, by their statements', async () => {
    const { control } = mount();
    expect(control.takeAxisLine('axis-line')).toBe('taken');
    expect(control.value()).toEqual({ kind: 'axis', ...at(6) });
    expect(control.ghost()).toEqual({ kind: 'axis', filePath: FILE, line: 6 });
    expect(control.highlight().wireIds).toEqual(['axis-line']);

    // The click's own sub-selection routes the same way.
    expect(await control.takeClick('plane-quad', { type: 'plane', index: 0 })).toBe('taken');
    expect(control.value()).toEqual({ kind: 'plane', ...at(7) });
    expect(control.ghost()).toEqual({ kind: 'plane', filePath: FILE, line: 7 });
    expect(control.highlight()).toMatchObject({ wireIds: [], planeQuadIds: ['plane-quad'] });
  });

  it('accepts a straight edge as an axis, and a second click on it takes it back', async () => {
    const { control, text } = mount();
    expect(await control.takeClick('block-solid', edge(0))).toBe('taken');
    expect(control.value()).toEqual({ kind: 'edge', entity: picked('edge', 0) });
    expect(control.ghost()).toEqual({ kind: 'edge', shapeId: 'block-solid', index: 0 });
    expect(control.highlight().entities).toEqual([picked('edge', 0)]);
    expect(text()).toContain('Picked edge');

    expect(await control.takeClick('block-solid', edge(0))).toBe('taken');
    expect(control.value()).toBeNull();
  });

  it('accepts a planar face as a plane', async () => {
    const { control, text } = mount();
    expect(await control.takeClick('block-solid', face(0))).toBe('taken');
    expect(control.value()).toEqual({ kind: 'face', entity: picked('face', 0) });
    expect(control.ghost()).toEqual({ kind: 'face', shapeId: 'block-solid', index: 0 });
    expect(text()).toContain('Picked face');
  });

  it('accepts a connector, a copy with its slot', () => {
    const { control, text } = mount();
    expect(control.takeConnector('bolt-1')).toBe('taken');
    expect(control.value()).toEqual({ kind: 'connector', ...at(8), slot: 1 });
    expect(control.ghost()).toEqual({ kind: 'connector', filePath: FILE, line: 8, slot: 1 });
    expect(control.highlight().connectorIds).toEqual(['bolt-1']);
    expect(text()).toContain('bolt.instance(1)');

    expect(control.takeConnector('nothing')).toMatchObject({ message: expect.stringContaining('connector') });
  });

  it('refuses a curved face with the row\'s message, and keeps what it held', async () => {
    const { control } = mount();
    control.takeStandard('z');
    expect(await control.takeClick('block-solid', face(1)))
      .toEqual({ message: 'That face is curved — a direction is read from a planar face.' });
    expect(control.value()).toEqual({ kind: 'standard', axis: 'z' });
  });

  it('refuses a curved edge, with the message its dialog gave the row', async () => {
    const { control } = mount({ refusal: 'Project along a straight edge or a planar face.' });
    expect(await control.takeClick('block-solid', edge(1))).toEqual({ message: 'Project along a straight edge or a planar face.' });
    expect(control.value()).toBeNull();

    const plain = mount();
    expect(await plain.control.takeClick('block-solid', edge(1)))
      .toEqual({ message: 'That edge is curved — a direction is read from a straight edge.' });
  });

  it('takes a pick the engine cannot name, and leaves the build to decide', async () => {
    const { control } = mount();
    expect(await control.takeClick('block-solid', face(7))).toBe('taken');
    expect(control.value()).toEqual({ kind: 'face', entity: picked('face', 7) });
  });

  it('drops the answer about a click another pick overtook', async () => {
    const answers: ((geometry: DirectionGeometry) => void)[] = [];
    const { control } = mount({ classify: () => new Promise(resolve => { answers.push(resolve); }) });
    const slow = control.takeClick('block-solid', edge(0));
    control.takeStandard('x');
    answers[0]('straight');
    expect(await slow).toBe('ignored');
    expect(control.value()).toEqual({ kind: 'standard', axis: 'x' });
  });

  it('takes the timeline row of an axis, a plane or a connector, and no other', () => {
    const { control } = mount();
    expect(control.takeRow(rowOf('ax'))).toBe('taken');
    expect(control.value()).toEqual({ kind: 'axis', ...at(6) });
    expect(control.takeRow(rowOf('pl'))).toBe('taken');
    expect(control.value()).toEqual({ kind: 'plane', ...at(7) });
    expect(control.takeRow(rowOf('bolt'))).toBe('taken');
    expect(control.value()).toEqual({ kind: 'connector', ...at(8) });

    expect(control.takeRow(rowOf('block'))).toBe('ignored');
    expect(control.value()).toEqual({ kind: 'connector', ...at(8) });
  });

  it('ignores a click that is no edge, face, axis or plane', async () => {
    const { control, asked } = mount();
    expect(await control.takeClick('block-solid', { type: 'sketch', index: 0 })).toBe('ignored');
    expect(await control.takeClick('block-solid', null)).toBe('ignored');
    expect(asked).toEqual([]);
  });

  it('re-finds a statement after a render and drops a picked edge, whose id the render re-minted', async () => {
    const { control } = mount();
    control.takeAxisLine('axis-line');
    expect(control.setScene(scene('-2'))).toBe(false);
    expect(control.value()).toEqual({ kind: 'axis', ...at(6) });
    expect(control.highlight().wireIds).toEqual(['axis-line-2']);

    await control.takeClick('block-solid-2', edge(0));
    expect(control.setScene(scene('-3'))).toBe(true);
    expect(control.value()).toBeNull();

    // A statement the scene no longer holds drops too.
    control.takePlaneQuad('plane-quad-3');
    expect(control.setScene(scene('-4').filter(o => o.type !== 'plane'))).toBe(true);
    expect(control.value()).toBeNull();
  });

  it('the chip\'s ✕ empties the slot and says so', async () => {
    const { control, remove } = mount();
    const changes: number[] = [];
    control.onChange = () => changes.push(1);
    await control.takeClick('block-solid', face(0));
    expect(changes).toEqual([]);
    remove();
    expect(control.value()).toBeNull();
    expect(control.highlight().entities).toEqual([]);
    expect(changes).toEqual([1]);
  });

  it('asks the engine what a pick is when its dialog brings no reader of its own', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url);
      const body = url.startsWith('api/face-properties')
        ? { surfaceType: url.includes('faceIndex=1') ? 'cylinder' : 'plane' }
        : { curveType: url.includes('edgeIndex=1') ? 'arc' : 'line' };
      return { ok: true, json: async () => body };
    }));
    const host = document.createElement('div');
    document.body.appendChild(host);
    const control = new DirectionSlotControl(host);
    control.setScene(scene());

    expect(await control.takeClick('block-solid', face(1))).toMatchObject({ message: expect.stringContaining('curved') });
    expect(await control.takeClick('block-solid', edge(1))).toMatchObject({ message: expect.stringContaining('curved') });
    expect(await control.takeClick('block-solid', face(0))).toBe('taken');
    expect(await control.takeClick('block-solid', edge(0))).toBe('taken');
    expect(control.value()).toEqual({ kind: 'edge', entity: picked('edge', 0) });
    expect(urls.filter(url => url.startsWith('api/face-properties'))).toHaveLength(2);
    expect(urls.filter(url => url.startsWith('api/edge-properties'))).toHaveLength(2);
  });
});

describe('DirectionSlotControl — an edit', () => {
  it('reads a world-axis or an origin-plane literal as that axis or plane', () => {
    const { control } = mount();
    control.seedKeep("'z'");
    expect(control.value()).toEqual({ kind: 'standard', axis: 'z' });
    control.seedKeep('"xy"');
    expect(control.value()).toEqual({ kind: 'standard-plane', plane: 'xy' });
  });

  it('keeps any other direction as written, lit and previewed as the engine resolved it', () => {
    const { control, text } = mount();
    control.seedKeep('datum', { kind: 'sketch', ...at(7) });
    expect(text()).toContain('Current: datum');
    expect(control.value()).toEqual({ keep: true });
    // The statement it names is a plane() here, so the preview reads a plane.
    expect(control.ghost()).toEqual({ kind: 'plane', filePath: FILE, line: 7 });
    expect(control.highlight()).toMatchObject({ planeQuadIds: ['plane-quad'], wireIds: [] });

    control.setKeptSource({ kind: 'sketch', ...at(6) });
    expect(control.ghost()).toEqual({ kind: 'axis', filePath: FILE, line: 6 });
    expect(control.highlight()).toMatchObject({ planeQuadIds: [], wireIds: ['axis-line'] });

    control.setKeptSource({ kind: 'entities', entities: [picked('face', 0)] });
    expect(control.ghost()).toEqual({ kind: 'face', shapeId: 'block-solid', index: 0 });
    expect(control.highlight().entities).toEqual([picked('face', 0)]);

    control.setKeptSource({ kind: 'opaque' });
    expect(control.ghost()).toBeNull();
  });

  it('shows a kept connector as its own chip, still kept as written', () => {
    const { control, text } = mount();
    control.seedKeep('bolt.instance(1)', { kind: 'connector', ...at(8), slot: 1 });
    expect(control.value()).toEqual({ keep: true });
    expect(text()).toContain('bolt.instance(1)');
    expect(text()).not.toContain('Current:');
    expect(control.ghost()).toEqual({ kind: 'connector', filePath: FILE, line: 8, slot: 1 });
    expect(control.highlight().connectorIds).toEqual(['bolt-1']);

    // A render re-mints its id: the kept connector is found again by its site.
    control.setScene(scene('-2'));
    expect(control.highlight().connectorIds).toEqual(['bolt-1-2']);
  });

  it('a pick replaces the kept direction, and its ✕ goes back to it', async () => {
    const { control, remove } = mount();
    control.seedKeep('datum', { kind: 'sketch', ...at(7) });
    await control.takeClick('block-solid', edge(0));
    expect(control.value()).toEqual({ kind: 'edge', entity: picked('edge', 0) });
    remove();
    expect(control.value()).toEqual({ keep: true });

    // A fresh create forgets it.
    control.reset();
    expect(control.value()).toBeNull();
    expect(control.ghost()).toBeNull();
  });
});
