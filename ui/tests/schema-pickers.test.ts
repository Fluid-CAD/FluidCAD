// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import type { FeaturePickerParam } from '../src/api';
import { PickHighlight, SchemaPicker, type PickerScene } from '../src/interactive/create-feature/schema/schema-pickers';
import type { SceneObjectRender, SourceLocation } from '../src/types';
import { CustomFeatureTypes } from '../src/ui/custom-feature-types';

// One picked value of a custom feature's dialog: what each picker kind takes
// from the viewport and the timeline, what the armed slot asks the viewer to
// offer, how its picks survive a render, how an edit keeps the statement's
// own elements, and the request elements it writes.

afterEach(() => {
  document.body.innerHTML = '';
});

const FILE = '/ws/plate.part.js';
const at = (line: number, column = 2): SourceLocation => ({ filePath: FILE, line, column });
const MESH = [{ vertices: [], indices: [] }] as never;

/**
 * A part holding a plate, a sketch with a circle, an axis and a plane
 * statement, a boss and a fillet — and a second part with a solid of its own.
 */
function scene(opts: { sketchShapeId?: string; withoutSketch?: boolean } = {}): SceneObjectRender[] {
  const rows: SceneObjectRender[] = [
    { id: 'part', type: 'part', name: 'Plate', isContainer: true, sceneShapes: [], ownShapes: [], sourceLocation: at(3, 22) },
    {
      id: 'plate', type: 'extrude', name: 'Extrude', parentId: 'part', ownShapes: [], sourceLocation: at(5, 16),
      sceneShapes: [{ shapeId: 'plate-solid', shapeType: 'solid', meshes: MESH }],
    },
    ...(opts.withoutSketch ? [] : [
      { id: 'sk', type: 'sketch', name: 'Sketch', parentId: 'part', isContainer: true, sceneShapes: [], ownShapes: [], sourceLocation: at(6, 12) },
      {
        id: 'circle', type: 'circle', name: 'Circle', parentId: 'sk', ownShapes: [], sourceLocation: at(7, 4),
        sceneShapes: [{ shapeId: opts.sketchShapeId ?? 'circle-wire', shapeType: 'edge', meshes: MESH }],
      },
    ] as SceneObjectRender[]),
    {
      id: 'ax', type: 'axis', name: 'Axis', parentId: 'part', ownShapes: [], sourceLocation: at(9, 13),
      sceneShapes: [{ shapeId: 'axis-line', shapeType: 'edge', isMetaShape: true, meshes: MESH }],
    },
    {
      id: 'pl', type: 'plane', name: 'Plane', parentId: 'part', ownShapes: [], sourceLocation: at(10, 13),
      sceneShapes: [{ shapeId: 'plane-quad', shapeType: 'face', isMetaShape: true, meshes: MESH }],
    },
    {
      id: 'boss', type: 'extrude', name: 'Boss', parentId: 'part', ownShapes: [], sourceLocation: at(12, 15),
      sceneShapes: [{ shapeId: 'boss-solid', shapeType: 'solid', meshes: MESH }],
    },
    {
      id: 'fil', type: 'fillet', name: 'Fillet', parentId: 'part', ownShapes: [], sourceLocation: at(13, 15),
      sceneShapes: [{ shapeId: 'fil-solid', shapeType: 'solid', meshes: MESH }],
    },
    { id: 'part2', type: 'part', name: 'Lid', isContainer: true, sceneShapes: [], ownShapes: [], sourceLocation: at(20, 20) },
    {
      id: 'lid', type: 'extrude', name: 'Lid body', parentId: 'part2', ownShapes: [], sourceLocation: at(21, 14),
      sceneShapes: [{ shapeId: 'lid-solid', shapeType: 'solid', meshes: MESH }],
    },
  ];
  return rows;
}

const inPart = (objects: SceneObjectRender[]): PickerScene => ({ objects, partLoc: at(3, 22) });
const row = (id: string, objects = scene()) => objects.find(o => o.id === id)!;

function mount(spec: Partial<FeaturePickerParam> & { picker: FeaturePickerParam['picker'] }, name = 'value'): SchemaPicker {
  const picker = new SchemaPicker(name, { label: 'Value', ...spec } as FeaturePickerParam);
  document.body.appendChild(picker.row);
  picker.setScene(inPart(scene()), { dropEntities: true });
  picker.reset();
  return picker;
}

const chips = (picker: SchemaPicker) =>
  [...picker.row.querySelectorAll<HTMLElement>('span.truncate[title], button.truncate[title]')].map(el => el.textContent);
const removeChip = (picker: SchemaPicker, index: number) =>
  picker.row.querySelectorAll<HTMLButtonElement>('button[title="Remove this selection"]')[index].click();
const face = (index: number, shapeId = 'plate-solid') => ({ shapeId, sub: { type: 'face' as const, index } });
const edge = (index: number, shapeId = 'plate-solid') => ({ shapeId, sub: { type: 'edge' as const, index } });

describe('face and edge values', () => {
  it('take a face, show it, write it as picked geometry — and a second click on it takes it back', () => {
    const picker = mount({ picker: 'face', surface: 'planar', label: 'On face' });
    expect(picker.channels()).toMatchObject({ pickFilter: 'face', sketchWires: false, axes: false, planes: false });
    expect(picker.takeClick('plate-solid', edge(0).sub)).toBe('ignored');

    expect(picker.takeClick('plate-solid', face(4).sub)).toBe('taken');
    expect(chips(picker)).toEqual(['Picked face']);
    expect(picker.request()).toEqual([{ kind: 'entities', entities: [face(4)] }]);

    // A single value swaps a new pick in.
    picker.takeClick('plate-solid', face(5).sub);
    expect(picker.request()).toEqual([{ kind: 'entities', entities: [face(5)] }]);
    picker.takeClick('plate-solid', face(5).sub);
    expect(picker.isEmpty).toBe(true);
    expect(picker.request()).toEqual({ error: 'On face: pick a planar face.' });
  });

  it('hold a list up to its max, every pick in one geometry element', () => {
    const picker = mount({ picker: 'face', multiple: true, max: 2, label: 'Faces' });
    picker.takeClick('plate-solid', face(1).sub);
    picker.takeClick('plate-solid', face(2).sub);
    expect(picker.takeClick('plate-solid', face(3).sub)).toEqual({ message: 'Faces takes at most 2.' });
    expect(picker.request()).toEqual([{ kind: 'entities', entities: [face(1), face(2)] }]);
    picker.takeClick('plate-solid', face(1).sub);
    expect(picker.request()).toEqual([{ kind: 'entities', entities: [face(2)] }]);
  });

  it('let a face stand for its edges when the edge value says so', () => {
    const edges = mount({ picker: 'edge', multiple: true });
    expect(edges.channels().pickFilter).toBe('edge');
    expect(edges.takeClick('plate-solid', face(1).sub)).toBe('ignored');
    const rims = mount({ picker: 'edge', multiple: true, facesAsEdges: true });
    expect(rims.channels().pickFilter).toBe('all');
    expect(rims.takeClick('plate-solid', face(1).sub)).toBe('taken');
    expect(rims.takeClick('plate-solid', edge(2).sub)).toBe('taken');
    expect(chips(rims)).toEqual(['Picked face', 'Picked edge']);
    // The picks as picked: tangent chains are for fillet and chamfer only, never a custom feature's.
    expect(rims.request()).toStrictEqual([{ kind: 'entities', entities: [face(1), edge(2)] }]);
  });

  it('drop their picks on a render, whose ids are new', () => {
    const picker = mount({ picker: 'face' });
    picker.takeClick('plate-solid', face(1).sub);
    expect(picker.setScene(inPart(scene()), { dropEntities: true })).toBe(true);
    expect(picker.isEmpty).toBe(true);
  });
});

describe('statement values', () => {
  it('take a sketch from its timeline row, a child row or a wire, and re-find it after a render', () => {
    const picker = mount({ picker: 'sketch', label: 'Profile' });
    expect(picker.channels()).toMatchObject({ pickFilter: 'none', sketchWires: true });
    expect(picker.takeRow(row('boss'))).toBe('ignored');
    expect(picker.takeRow(row('circle'))).toBe('taken');
    expect(picker.request()).toEqual([{ kind: 'statement', filePath: FILE, line: 6, column: 12 }]);

    // New ids, same statement: the pick stays.
    expect(picker.setScene(inPart(scene({ sketchShapeId: 'circle-wire-2' })), { dropEntities: true })).toBe(false);
    expect(picker.request()).toEqual([{ kind: 'statement', filePath: FILE, line: 6, column: 12 }]);
    picker.takeSketchWire('circle-wire-2');
    expect(picker.isEmpty).toBe(true);
    expect(picker.takeSketchWire('circle-wire-2')).toBe('taken');

    // The statement is gone: so is the pick.
    expect(picker.setScene(inPart(scene({ withoutSketch: true })), { dropEntities: true })).toBe(true);
    expect(picker.isEmpty).toBe(true);
  });

  it('take a world axis, an axis statement or an edge as an axis', () => {
    const picker = mount({ picker: 'axis', label: 'Around' });
    expect(picker.channels()).toMatchObject({ pickFilter: 'edge', axes: true, standardAxes: true, standardPlanes: false });
    expect(picker.takeStandard('xy')).toBe('ignored');
    expect(picker.takeStandard('z')).toBe('taken');
    expect(chips(picker)).toEqual(['World Z axis']);
    expect(picker.request()).toEqual([{ kind: 'standard', name: 'z' }]);
    const lit = new PickHighlight();
    picker.highlight(lit);
    expect(lit.standardAxes).toEqual(['z']);

    expect(picker.takeAxisLine('axis-line')).toBe('taken');
    expect(picker.request()).toEqual([{ kind: 'statement', filePath: FILE, line: 9, column: 13 }]);
    // Its row is the same axis: picking it again takes it back.
    expect(picker.takeRow(row('ax'))).toBe('taken');
    expect(picker.isEmpty).toBe(true);
    picker.takeRow(row('ax'));
    expect(chips(picker)).toEqual(['Axis']);

    picker.takeClick('plate-solid', edge(3).sub);
    expect(picker.request()).toEqual([{ kind: 'entities', entities: [edge(3)] }]);
  });

  it('take an origin plane, a plane statement or a face as a plane', () => {
    const picker = mount({ picker: 'plane' });
    expect(picker.channels()).toMatchObject({ pickFilter: 'face', planes: true, standardPlanes: true });
    expect(picker.takeStandard('z')).toBe('ignored');
    picker.takeStandard('xz');
    expect(chips(picker)).toEqual(['XZ plane']);
    expect(picker.takePlaneQuad('plane-quad')).toBe('taken');
    expect(picker.request()).toEqual([{ kind: 'statement', filePath: FILE, line: 10, column: 13 }]);
    const lit = new PickHighlight();
    picker.highlight(lit);
    expect(lit.planeQuadIds).toEqual(['plane-quad']);
    picker.takeClick('plate-solid', face(2).sub);
    expect(picker.request()).toEqual([{ kind: 'entities', entities: [face(2)] }]);
  });

  it("take a whole solid from any of its faces or its row — only one the statement's part can name", () => {
    const picker = mount({ picker: 'solid', multiple: true, label: 'Bodies' });
    expect(picker.channels().pickFilter).toBe('all');
    picker.takeClick('boss-solid', face(0, 'boss-solid').sub);
    picker.takeRow(row('plate'));
    expect(picker.request()).toEqual([
      { kind: 'statement', filePath: FILE, line: 12, column: 15 },
      { kind: 'statement', filePath: FILE, line: 5, column: 16 },
    ]);
    expect(picker.takeClick('lid-solid', face(0, 'lid-solid').sub))
      .toEqual({ message: 'Bodies: that shape is not a solid this statement can reference.' });
    expect(picker.takeRow(row('lid'))).toEqual({ message: 'That solid is in another part — this statement cannot reference it.' });
    const lit = new PickHighlight();
    picker.highlight(lit);
    expect(lit.solidIds).toEqual(['boss-solid', 'plate-solid']);
  });

  it('take a feature from the timeline only, of the types it names', () => {
    const picker = mount({ picker: 'feature', types: ['fillet'], label: 'Follow' });
    expect(picker.channels().pickFilter).toBe('none');
    expect(picker.takeClick('fil-solid', face(0, 'fil-solid').sub)).toBe('ignored');
    expect(picker.takeRow(row('boss'))).toEqual({ message: 'Follow takes fillet features.' });
    expect(picker.takeRow(row('fil'))).toBe('taken');
    expect(chips(picker)).toEqual(['Fillet']);
  });

  it('open on the sketch being edited, and refuse it while it is empty where the value wants geometry', () => {
    // A top-level sketch the file ends in is the one being edited — drawn on or not.
    const objects = [
      ...scene().filter(o => o.id === 'plate').map(o => ({ ...o, parentId: undefined })),
      { id: 'tip', type: 'sketch', name: 'Sketch', isContainer: true, sceneShapes: [], ownShapes: [], sourceLocation: at(30, 10) },
    ] as SceneObjectRender[];
    const picker = new SchemaPicker('profile', { picker: 'sketch', label: 'Profile', hasGeometry: true });
    picker.setScene({ objects, partLoc: null }, { dropEntities: true });
    picker.reset();
    expect(chips(picker)).toEqual(['Last Sketch']);
    expect(picker.request()).toEqual({ error: 'Nothing is drawn in "Last Sketch" yet.' });
  });
});

describe('an empty value', () => {
  it('is left out when optional or the active sketch, and refused when required', () => {
    expect(mount({ picker: 'edge', optional: true }).request()).toBeUndefined();
    expect(mount({ picker: 'sketch', implicitDefault: true }).request()).toBeUndefined();
    expect(mount({ picker: 'solid', label: 'Body' }).request()).toEqual({ error: 'Body: pick a solid.' });
  });

  it('asks for a required location by what the value takes', () => {
    expect(mount({ picker: 'connector', label: 'At' }).request()).toEqual({ error: 'At: pick a connector.' });
    expect(mount({ picker: ['connector', 'point', 'anchor'], multiple: true, label: 'At' }).request())
      .toEqual({ error: 'At: pick connectors, points (vertices) or face or edge centres.' });
  });
});

describe('an edited statement', () => {
  const picks = [
    { text: 'e.endFaces()', start: 0, end: 12 },
    { text: 's', start: 14, end: 15, ref: { line: 6, column: 12 } },
  ];

  it('keeps its own elements verbatim until the value changes', () => {
    const picker = mount({ picker: 'face', multiple: true, label: 'Faces' });
    picker.seedKeeps(picks, FILE);
    expect(chips(picker)).toEqual(['Current: e.endFaces()', 'Current: s']);
    expect(picker.touched).toBe(false);
    expect(picker.request()).toBeUndefined();

    removeChip(picker, 0);
    expect(picker.request()).toEqual([{ kind: 'verbatim', sourceIndex: 1 }]);
    picker.takeClick('plate-solid', face(7).sub);
    expect(picker.request()).toEqual([{ kind: 'verbatim', sourceIndex: 1 }, { kind: 'entities', entities: [face(7)] }]);
    removeChip(picker, 0);
    removeChip(picker, 0);
    expect(picker.request()).toEqual({ error: 'Faces: pick faces.' });
  });

  it("undoes a single value's re-pick back to its own element, which only an optional value lets go", () => {
    const picker = mount({ picker: 'face', label: 'On face' });
    picker.seedKeeps([picks[0]], FILE);
    picker.takeClick('plate-solid', face(1).sub);
    expect(picker.touched).toBe(true);
    removeChip(picker, 0);
    expect(picker.touched).toBe(false);
    expect(chips(picker)).toEqual(['Current: e.endFaces()']);
    expect(picker.row.querySelector('button[title="Remove this selection"]')).toBeNull();

    const optional = mount({ picker: 'face', label: 'Stop at', optional: true });
    optional.seedKeeps([picks[0]], FILE);
    removeChip(optional, 0);
    expect(optional.request()).toEqual([]);
  });

  it('names a kept variable after its statement, and lets its row toggle it off', () => {
    const picker = mount({ picker: 'sketch', multiple: true, label: 'Profiles' });
    picker.seedKeeps([picks[1]], FILE);
    expect(chips(picker)).toEqual(['Sketch']);
    picker.takeRow(row('sk'));
    expect(picker.isEmpty).toBe(true);
  });

  it("lights up what the engine resolved a kept selection to, and reads a world axis off its text", () => {
    const faces = mount({ picker: 'face' });
    faces.seedKeeps([picks[0]], FILE);
    faces.setSources({ kind: 'entities', entities: [face(3)] });
    const lit = new PickHighlight();
    faces.highlight(lit);
    expect(lit.entities).toEqual([face(3)]);

    const around = mount({ picker: 'axis' });
    around.seedKeeps([{ text: "'y'", start: 0, end: 3 }], FILE);
    expect(chips(around)).toEqual(['World Y axis']);
    const axes = new PickHighlight();
    around.highlight(axes);
    expect(axes.standardAxes).toEqual(['y']);
  });

  it('stands on what its feature took for a value the statement leaves out — draft(5) drafts the last selection', () => {
    const picker = mount({ picker: 'face', multiple: true, label: 'Faces' });
    picker.seedKeeps(undefined, FILE);
    expect(chips(picker)).toEqual([]);
    picker.setSources([{ kind: 'entities', entities: [face(3), face(5)] }]);
    expect(chips(picker)).toEqual(['Current: last selected face', 'Current: last selected face']);
    expect(picker.touched).toBe(false);
    // Untouched, the statement keeps leaving it out.
    expect(picker.request()).toBeUndefined();
    expect(picker.hasPickedGeometry).toBe(false);
    const lit = new PickHighlight();
    picker.highlight(lit);
    expect(lit.entities).toEqual([face(3), face(5)]);
    expect(picker.ghostRefs()).toEqual([{ kind: 'entities', entities: [
      { shapeId: 'plate-solid', index: 3, kind: 'face' }, { shapeId: 'plate-solid', index: 5, kind: 'face' },
    ] }]);

    // Changed, the faces it took are written with the new pick; a click on one takes it off.
    picker.takeClick('plate-solid', face(8).sub);
    picker.takeClick('plate-solid', face(3).sub);
    expect(picker.touched).toBe(true);
    expect(picker.request()).toEqual([{ kind: 'entities', entities: [face(5), face(8)] }]);
    expect(picker.hasPickedGeometry).toBe(true);
    removeChip(picker, 0);
    removeChip(picker, 0);
    expect(picker.request()).toEqual({ error: 'Faces: pick faces.' });
  });

  it("re-reads what its feature took after a stale render, and a single value's re-pick undoes back to it", () => {
    const picker = mount({ picker: 'face', multiple: true });
    picker.seedKeeps([], FILE);
    picker.setSources([{ kind: 'entities', entities: [face(3)] }]);
    // A stale render's new ids: the faces drop quietly, untouched, until the sources come back.
    expect(picker.setScene(inPart(scene()), { dropEntities: true })).toBe(false);
    expect(picker.value).toEqual([]);
    expect(picker.touched).toBe(false);
    picker.setSources([{ kind: 'entities', entities: [face(4)] }]);
    expect(picker.value).toEqual([{ kind: 'entity', entity: face(4) }]);
    expect(picker.request()).toBeUndefined();

    const single = mount({ picker: 'face', label: 'On face' });
    single.seedKeeps(undefined, FILE);
    single.setSources({ kind: 'entities', entities: [face(2)] });
    expect(single.row.querySelector('button[title="Remove this selection"]')).toBeNull();
    single.takeClick('plate-solid', face(6).sub);
    removeChip(single, 0);
    expect(single.value).toEqual([{ kind: 'entity', entity: face(2) }]);
    expect(single.touched).toBe(false);

    // Nothing to stand on: an opaque source, or none.
    const opaque = mount({ picker: 'face', multiple: true });
    opaque.seedKeeps(undefined, FILE);
    opaque.setSources([{ kind: 'opaque' }]);
    expect(opaque.isEmpty).toBe(true);
    expect(opaque.request()).toBeUndefined();
  });

  it('keeps its elements through a render, and a stale one drops only the re-picks', () => {
    const picker = mount({ picker: 'face', multiple: true });
    picker.seedKeeps(picks, FILE);
    picker.takeClick('plate-solid', face(9).sub);
    picker.setScene(inPart(scene()), { dropEntities: false });
    expect(picker.value).toHaveLength(3);
    picker.setScene(inPart(scene()), { dropEntities: true });
    expect(picker.value.map(e => e.kind)).toEqual(['keep', 'keep']);
  });
});

// ---------------------------------------------------------------------------
// Locations: connectors, points, anchors — and values of several kinds.
// ---------------------------------------------------------------------------

const ORIGIN = { x: 0, y: 0, z: 10 };
const Z = { x: 0, y: 0, z: 1 };
const X = { x: 1, y: 0, z: 0 };
const Y = { x: 0, y: 1, z: 0 };

/**
 * The scene plus a connector on the plate's top (line 14) and its copy (slot
 * 1, made by the copy statement at line 15); `suffix` renames the rows' ids
 * the way a new render mints new ones.
 */
function connectorScene(suffix = ''): SceneObjectRender[] {
  const frame = { origin: ORIGIN, xDirection: X, yDirection: Y, normal: Z };
  return [
    ...scene(),
    {
      id: `bolt${suffix}`, type: 'connector', name: 'bolt', parentId: 'part', ownShapes: [], sceneShapes: [], sourceLocation: at(14, 15),
      object: { name: 'bolt', ...frame },
    },
    {
      id: `copy${suffix}`, type: 'copy', name: 'Copy', parentId: 'part', ownShapes: [], sceneShapes: [], sourceLocation: at(15, 2),
      object: { connectorCopies: { seeds: [{ id: `bolt${suffix}` }] } },
    },
    {
      id: `bolt-1${suffix}`, type: 'connector', name: 'bolt', parentId: `copy${suffix}`, ownShapes: [], sceneShapes: [], sourceLocation: at(15, 2),
      object: { name: 'bolt', ...frame, origin: { x: 15, y: 0, z: 10 }, copy: { seedId: `bolt${suffix}`, slot: 1 } },
    },
  ] as SceneObjectRender[];
}

function mountAt(spec: Partial<FeaturePickerParam> & { picker: FeaturePickerParam['picker'] }, objects = connectorScene()): SchemaPicker {
  const picker = new SchemaPicker('at', { label: 'At', ...spec } as FeaturePickerParam);
  document.body.appendChild(picker.row);
  picker.setScene(inPart(objects), { dropEntities: true });
  picker.reset();
  return picker;
}

const vertex = (index: number, shapeId = 'plate-solid') => ({ shapeId, sub: { type: 'vertex' as const, index } });

/** A face's centre, as the suggestion rail locks it. */
function faceCentre(index = 4, kind: 'center' | 'start' = 'center') {
  const entity = { shapeId: 'plate-solid', sub: { type: 'face' as const, index } };
  const frame = { origin: ORIGIN, xDirection: X, yDirection: Y, normal: Z };
  return {
    entity,
    key: `plate-solid:face:${index}`,
    anchors: [{ anchor: { kind }, suffix: `.${kind}()`, frame }],
    anchorIndex: 0,
    args: null,
    inPart: true,
    defaultName: null,
  } as Parameters<SchemaPicker['takeAnchor']>[0];
}

describe('connector values', () => {
  it('take a gizmo or a timeline row, a copy by its seed statement and slot', () => {
    const picker = mountAt({ picker: 'connector', multiple: true });
    expect(picker.channels()).toMatchObject({ pickFilter: 'none', connectors: true, vertices: false, anchors: false });
    expect(picker.takeConnector('bolt')).toBe('taken');
    expect(picker.takeRow(row('bolt-1', connectorScene()))).toBe('taken');
    expect(picker.takeConnector('nowhere')).toEqual({ message: 'That connector cannot be referenced — only connector() features and their copies can be picked.' });
    expect(chips(picker)).toEqual(['Connector bolt', 'Connector bolt.instance(1)']);
    expect(picker.request()).toEqual([
      { kind: 'statement', filePath: FILE, line: 14, column: 15 },
      { kind: 'statement', filePath: FILE, line: 14, column: 15, slot: 1 },
    ]);
    expect(picker.ghostRefs()).toEqual([
      { kind: 'connector', filePath: FILE, line: 14 },
      { kind: 'connector', filePath: FILE, line: 14, slot: 1 },
    ]);
    const lit = new PickHighlight();
    picker.highlight(lit);
    expect(lit.connectorIds).toEqual(['bolt', 'bolt-1']);
  });

  it('survive a render: each connector re-matched by its statement and slot', () => {
    const picker = mountAt({ picker: 'connector', multiple: true });
    picker.takeConnector('bolt-1');
    expect(picker.setScene(inPart(connectorScene('#2')), { dropEntities: true })).toBe(false);
    const lit = new PickHighlight();
    picker.highlight(lit);
    expect(lit.connectorIds).toEqual(['bolt-1#2']);
    expect(picker.request()).toEqual([{ kind: 'statement', filePath: FILE, line: 14, column: 15, slot: 1 }]);
  });
});

describe('an axis value takes a connector — its Z axis through its origin', () => {
  it('offers the gizmos with its axis channels, and writes a connector it took as one', () => {
    const picker = mountAt({ picker: 'axis', label: 'Around' });
    expect(picker.channels()).toMatchObject({ pickFilter: 'edge', axes: true, standardAxes: true, connectors: true });
    expect(picker.takesConnectors).toBe(true);
    expect(picker.takeConnector('bolt-1')).toBe('taken');
    expect(chips(picker)).toEqual(['Connector bolt.instance(1)']);
    // The kind it was picked as rides along: the server binds the connector, not an axis().
    expect(picker.request()).toEqual([{ kind: 'statement', filePath: FILE, line: 14, column: 15, picker: 'connector', slot: 1 }]);
    expect(picker.ghostRefs()).toEqual([{ kind: 'connector', filePath: FILE, line: 14, slot: 1 }]);
    const lit = new PickHighlight();
    picker.highlight(lit);
    expect(lit.connectorIds).toEqual(['bolt-1']);

    // A connector row swaps in; an axis statement is written as one, its kind unnamed.
    expect(picker.takeRow(row('bolt', connectorScene()))).toBe('taken');
    expect(picker.request()).toEqual([{ kind: 'statement', filePath: FILE, line: 14, column: 15, picker: 'connector' }]);
    expect(picker.takeRow(row('ax', connectorScene()))).toBe('taken');
    expect(picker.request()).toEqual([{ kind: 'statement', filePath: FILE, line: 9, column: 13 }]);

    // A connector pick survives a render, found again by its statement and slot.
    picker.takeConnector('bolt-1');
    picker.setScene(inPart(connectorScene('#2')), { dropEntities: true });
    expect(picker.request()).toEqual([{ kind: 'statement', filePath: FILE, line: 14, column: 15, picker: 'connector', slot: 1 }]);
  });

  it("keeps an edit's connector axis — its chip, and its ghost by its site", () => {
    const picker = mountAt({ picker: 'axis', label: 'Around' });
    picker.seedKeeps([{ text: 'bolt.instance(1)', start: 0, end: 16, ref: { line: 14, column: 15, slot: 1 } }], FILE);
    picker.setSources({ kind: 'connector', filePath: FILE, line: 14, column: 15, slot: 1 });
    expect(chips(picker)).toEqual(['Connector bolt.instance(1)']);
    expect(picker.request()).toBeUndefined();
    expect(picker.ghostRefs()).toEqual([{ kind: 'connector', filePath: FILE, line: 14, slot: 1 }]);

    // Its ref unknown, the sources name it all the same.
    const fromSources = mountAt({ picker: 'axis', label: 'Around' });
    fromSources.seedKeeps([{ text: 'bolt', start: 0, end: 4 }], FILE);
    fromSources.setSources({ kind: 'connector', filePath: FILE, line: 14, column: 15 });
    expect(chips(fromSources)).toEqual(['Connector bolt']);
    expect(fromSources.ghostRefs()).toEqual([{ kind: 'connector', filePath: FILE, line: 14 }]);
  });
});

describe('point values', () => {
  it('take vertices only — offered alone, a face click passes — and drop them on a render', () => {
    const picker = mountAt({ picker: 'point', multiple: true });
    expect(picker.channels()).toMatchObject({ pickFilter: 'vertex', vertices: true, connectors: false });
    expect(picker.takeClick('plate-solid', face(4).sub)).toBe('ignored');
    expect(picker.takeClick('plate-solid', vertex(3).sub)).toBe('taken');
    expect(picker.takeClick('plate-solid', vertex(5).sub)).toBe('taken');
    expect(chips(picker)).toEqual(['Extrude vertex', 'Extrude vertex']);
    expect(picker.request()).toEqual([
      { kind: 'point', entity: vertex(3) },
      { kind: 'point', entity: vertex(5) },
    ]);
    expect(picker.ghostRefs()).toEqual([
      { kind: 'point', shapeId: 'plate-solid', index: 3 },
      { kind: 'point', shapeId: 'plate-solid', index: 5 },
    ]);
    expect(picker.hasPickedGeometry).toBe(true);
    expect(picker.setScene(inPart(connectorScene()), { dropEntities: true })).toBe(true);
    expect(picker.isEmpty).toBe(true);
  });

  it("name a custom feature's vertex by its row's name — its id is no word", () => {
    const objects = [...connectorScene(), {
      id: 'b', type: 'acme.boss', name: 'Boss', parentId: 'part', ownShapes: [], sourceLocation: at(16, 2),
      sceneShapes: [{ shapeId: 'boss-body', shapeType: 'solid', meshes: MESH }],
    }] as SceneObjectRender[];
    const picker = mountAt({ picker: 'point' }, objects);
    picker.takeClick('boss-body', vertex(0, 'boss-body').sub);
    expect(chips(picker)).toEqual(['Boss vertex']);
  });

  it("name a package feature's vertex (a keyed row, HD29) and a plain-id workspace feature's by the row's name", () => {
    for (const [type, name] of [['@acme/kit:boss', 'Boss (Acme)'], ['boss', 'Boss (mine)']]) {
      if (type === 'boss') {
        CustomFeatureTypes.register('boss');
      }
      const objects = [...connectorScene(), {
        id: 'b', type, name, parentId: 'part', ownShapes: [], sourceLocation: at(16, 2),
        sceneShapes: [{ shapeId: 'boss-body', shapeType: 'solid', meshes: MESH }],
      }] as SceneObjectRender[];
      const picker = mountAt({ picker: 'point' }, objects);
      picker.takeClick('boss-body', vertex(0, 'boss-body').sub);
      expect(chips(picker)).toEqual([`${name} vertex`]);
    }
    CustomFeatureTypes.unregister('boss');
    expect(CustomFeatureTypes.isCustom('boss')).toBe(false);
    expect(CustomFeatureTypes.isCustom('extrude')).toBe(false);
  });
});

describe('anchor values', () => {
  it('lock a face centre the rail suggests, only the anchors the value offers', () => {
    const picker = mountAt({ picker: 'anchor', anchors: ['center'] });
    expect(picker.channels()).toMatchObject({ pickFilter: 'all', anchors: true });
    // A face click is the rail's to lock, never a pick of its own.
    expect(picker.clickKind(face(4).sub)).toBe('anchor');
    expect(picker.takeClick('plate-solid', face(4).sub)).toBe('ignored');
    expect(picker.offersAnchor({ kind: 'start' })).toBe(false);
    expect(picker.takeAnchor(faceCentre(4, 'start'))).toEqual({ message: 'At takes anchors at center().' });

    expect(picker.takeAnchor(faceCentre(4))).toBe('taken');
    expect(picker.holdsAnchor('plate-solid:face:4', 0)).toBe(true);
    expect(chips(picker)).toEqual(['Face center']);
    expect(picker.request()).toEqual([{ kind: 'anchor', entity: face(4), anchor: { kind: 'center' } }]);
    expect(picker.ghostRefs()).toEqual([
      { kind: 'anchor', entity: { shapeId: 'plate-solid', index: 4, kind: 'face' }, anchor: { kind: 'center' } },
    ]);
    const lit = new PickHighlight();
    picker.highlight(lit);
    expect(lit.entities).toEqual([face(4)]);
    // Picking it again undoes it; a render drops it.
    picker.takeAnchor(faceCentre(4));
    expect(picker.isEmpty).toBe(true);
    picker.takeAnchor(faceCentre(4));
    expect(picker.setScene(inPart(connectorScene()), { dropEntities: true })).toBe(true);
    expect(picker.isEmpty).toBe(true);
  });
});

describe('a value of several kinds', () => {
  it('routes each pick to the kind that takes it, and writes them in the order they were picked', () => {
    const picker = mountAt({ picker: ['connector', 'point', 'anchor'], multiple: true, anchors: ['center'] });
    expect(picker.isUnion).toBe(true);
    expect(picker.channels()).toEqual({
      pickFilter: 'all', sketchWires: false, axes: false, planes: false, standardAxes: false, standardPlanes: false,
      connectors: true, vertices: true, anchors: true,
    });
    expect(picker.clickKind(vertex(1).sub)).toBe('point');
    expect(picker.clickKind(edge(2).sub)).toBe('anchor');

    picker.takeConnector('bolt');
    picker.takeClick('plate-solid', vertex(1).sub);
    picker.takeAnchor(faceCentre(4));
    picker.takeRow(row('bolt-1', connectorScene()));
    expect(picker.request()).toEqual([
      { kind: 'statement', filePath: FILE, line: 14, column: 15, picker: 'connector' },
      { kind: 'point', entity: vertex(1) },
      { kind: 'anchor', entity: face(4), anchor: { kind: 'center' } },
      { kind: 'statement', filePath: FILE, line: 14, column: 15, picker: 'connector', slot: 1 },
    ]);
    expect(picker.ghostRefs()!.map(ref => ref.kind)).toEqual(['connector', 'point', 'anchor', 'connector']);
  });

  it('takes a solid by a face click and a connector by its row, naming the kind each was picked as', () => {
    const picker = mountAt({ picker: ['solid', 'connector'], multiple: true });
    expect(picker.channels()).toMatchObject({ pickFilter: 'all', connectors: true, vertices: false, anchors: false });
    expect(picker.clickKind(face(1).sub)).toBe('solid');
    expect(picker.takeClick('boss-solid', face(1, 'boss-solid').sub)).toBe('taken');
    expect(picker.takeRow(row('bolt', connectorScene()))).toBe('taken');
    expect(picker.request()).toEqual([
      { kind: 'statement', filePath: FILE, line: 12, column: 15, picker: 'solid' },
      { kind: 'statement', filePath: FILE, line: 14, column: 15, picker: 'connector' },
    ]);
    expect(picker.ghostRefs()).toEqual([
      { kind: 'statement', filePath: FILE, line: 12 },
      { kind: 'connector', filePath: FILE, line: 14 },
    ]);
  });

  it('keeps an edited statement\'s own locations, a copy by its slot, and draws them from the feature itself', () => {
    const picker = mountAt({ picker: ['connector', 'point', 'anchor'], multiple: true });
    picker.seedKeeps([
      { text: 'bolt', start: 0, end: 4, ref: { line: 14, column: 15 } },
      { text: 'bolt.instance(1)', start: 6, end: 22, ref: { line: 14, column: 15, slot: 1 } },
      { text: 'e.endFaces().center()', start: 24, end: 45 },
    ], FILE);
    picker.setSources([
      { kind: 'sketch', filePath: FILE, line: 14, column: 15 },
      { kind: 'opaque' },
      { kind: 'entities', entities: [face(4)] },
    ]);
    expect(chips(picker)).toEqual(['Connector bolt', 'Connector bolt.instance(1)', 'Current: e.endFaces().center()']);
    expect(picker.request()).toBeUndefined();
    expect(picker.ghostRefs()).toEqual([{ kind: 'kept', index: 0 }, { kind: 'kept', index: 1 }, { kind: 'kept', index: 2 }]);
    const lit = new PickHighlight();
    picker.highlight(lit);
    expect(lit.connectorIds).toEqual(['bolt', 'bolt-1']);
    expect(lit.entities).toEqual([face(4)]);

    // A connector pick of a kept one is no new pick; a new point joins the keeps.
    picker.takeClick('plate-solid', vertex(2).sub);
    expect(picker.request()).toEqual([
      { kind: 'verbatim', sourceIndex: 0 },
      { kind: 'verbatim', sourceIndex: 1 },
      { kind: 'verbatim', sourceIndex: 2 },
      { kind: 'point', entity: vertex(2) },
    ]);
    expect(picker.hasPickedGeometry).toBe(true);
  });
});
