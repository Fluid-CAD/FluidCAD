// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import type { FeaturePickerParam } from '../src/api';
import { PickHighlight, SchemaPicker, type PickerScene } from '../src/interactive/create-feature/schema/schema-pickers';
import type { SceneObjectRender, SourceLocation } from '../src/types';

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

  it('is not offered yet for the location pickers', () => {
    const picker = mount({ picker: 'connector', label: 'At' });
    expect(picker.offered).toBe(false);
    expect(picker.request()).toBeUndefined();
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
