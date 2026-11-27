// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OperandSlotControl, type OperandKind } from '../src/interactive/create-feature/operand-slot';
import type { SceneObjectPart, SceneObjectRender, ShapeType, SubSelection } from '../src/types';

// A dialog row that collects curves or surfaces. What a click means is the
// same in every tool: standalone construction geometry — a curve object, a
// sketch, a surface — is taken whole and written as its variable; geometry
// on a solid is taken piece by piece and written as a selector. Which rows
// are curve objects and which hold a surface is read off what they hold.

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

const FILE = '/ws/m.fluid.js';
const MESH = [{ vertices: [0, 0, 0, 1, 0, 0], normals: [], indices: [0, 1] }];

function shape(shapeId: string, shapeType: ShapeType, extra: Partial<SceneObjectPart> = {}): SceneObjectPart {
  return { shapeId, shapeType, meshes: MESH, ...extra };
}

function row(r: Partial<SceneObjectRender> & { id: string }, line: number): SceneObjectRender {
  return { sourceLocation: { filePath: FILE, line, column: 0 }, sceneShapes: [], ownShapes: [], ...r };
}

/**
 * A sketch with one drawn curve, a block, a helix, a copied rail (a curve
 * that is no helix), a lofted surface, and a mirror holding a surface beside
 * a solid and a curve. `mint` re-mints the shape ids, as a render does.
 */
function scene(mint = ''): SceneObjectRender[] {
  const id = (name: string) => `${name}${mint}`;
  return [
    row({ id: 'sk', type: 'sketch', name: 'Sketch 1', isContainer: true }, 2),
    row({ id: 'ring', type: 'offset', parentId: 'sk', sceneShapes: [shape(id('ring-wire'), 'edge')] }, 3),
    row({ id: 'block', type: 'extrude', name: 'Extrude 1', sceneShapes: [shape(id('block-solid'), 'solid')] }, 5),
    row({ id: 'coil', type: 'helix', name: 'Helix 1', sceneShapes: [shape(id('coil-edge'), 'edge')] }, 6),
    row({ id: 'rail', type: 'copy-linear', name: 'Copy 1', sceneShapes: [shape(id('rail-wire'), 'wire')] }, 7),
    row({ id: 'skin', type: 'loft', name: 'Loft 1', sceneShapes: [shape(id('skin-surface'), 'surface')] }, 8),
    row({
      id: 'twin', type: 'mirror', name: 'Mirror 1',
      sceneShapes: [shape(id('twin-surface'), 'surface'), shape(id('twin-solid'), 'solid'), shape(id('twin-trace'), 'wire')],
    }, 9),
    row({ id: 'datum', type: 'plane', name: 'Plane 1', sceneShapes: [shape(id('datum-quad'), 'face', { isMetaShape: true })] }, 10),
  ];
}

const rowOf = (id: string, objects = scene()) => objects.find(o => o.id === id)!;
const edge = (index = 0): SubSelection => ({ type: 'edge', index });
const face = (index = 0): SubSelection => ({ type: 'face', index });

function mount(kind: OperandKind, multiple = true) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const control = new OperandSlotControl(host, {
    kind,
    label: kind === 'curve' ? 'Curves' : 'Surfaces',
    prompt: kind === 'curve' ? 'Pick curves or edges' : 'Pick surfaces or faces',
    multiple,
  });
  control.setScene(scene());
  const chips = () => [...host.querySelectorAll<HTMLElement>('span.truncate[title]')].map(el => el.textContent);
  const text = () => host.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  const remove = (index: number) =>
    host.querySelectorAll<HTMLButtonElement>('button[title="Remove this selection"]')[index].click();
  /** The picks as Apply reads them: an object by its row id, an entity as it is. */
  const sent = () => {
    const picks = control.picks();
    return 'keep' in picks ? 'keep' : picks.picks.map(pick => pick.kind === 'object' ? pick.row.id : pick.entity);
  };
  return { host, control, chips, text, remove, sent };
}

describe('OperandSlotControl — a curve row', () => {
  it('arms edges and sketch wires', () => {
    const { control, text } = mount('curve');
    expect(control.channels()).toMatchObject({ pickFilter: 'edge', sketchWires: true, axes: false, planes: false, connectors: false });
    expect(text()).toContain('Pick curves or edges');
  });

  it('takes the whole helix for a click on its edge, and the edge for a click on a solid\'s', () => {
    const { control, chips, sent } = mount('curve');
    expect(control.takeClick('coil-edge', edge())).toBe('taken');
    expect(control.takeClick('block-solid', edge(4))).toBe('taken');

    expect(chips()).toEqual(['Helix 1', 'Picked edge']);
    expect(sent()).toEqual(['coil', { shapeId: 'block-solid', sub: { type: 'edge', index: 4 } }]);
    const picks = control.picks();
    expect('keep' in picks).toBe(false);
    if (!('keep' in picks)) {
      expect(picks.objects.map(o => o.id)).toEqual(['coil']);
      expect(picks.entities).toEqual([{ shapeId: 'block-solid', sub: { type: 'edge', index: 4 } }]);
    }
  });

  it('takes any curve object whole, whatever made it, from whichever of its edges', () => {
    const { control, sent } = mount('curve');
    expect(control.takeClick('rail-wire', edge(3))).toBe('taken');
    expect(sent()).toEqual(['rail']);
    // Another edge of the same object is the same pick: it comes back off.
    expect(control.takeClick('rail-wire', edge(1))).toBe('taken');
    expect(sent()).toEqual([]);
  });

  it('takes an edge of a surface as that edge', () => {
    const { control, sent } = mount('curve');
    expect(control.takeClick('skin-surface', edge(2))).toBe('taken');
    expect(sent()).toEqual([{ shapeId: 'skin-surface', sub: { type: 'edge', index: 2 } }]);
  });

  it('takes a sketch whole from its wire', () => {
    const { control, chips, sent } = mount('curve');
    expect(control.takeClick('ring-wire', { type: 'sketch', index: 0 })).toBe('taken');
    expect(chips()).toEqual(['Sketch']);
    expect(sent()).toEqual(['sk']);
  });

  it('takes the timeline row of a sketch or a curve object, and no other', () => {
    const { control, sent } = mount('curve');
    expect(control.takeRow(rowOf('coil'))).toBe('taken');
    expect(control.takeRow(rowOf('sk'))).toBe('taken');
    // A sketch's entity row stands for its sketch: the same pick, taken back off.
    expect(control.takeRow(rowOf('ring'))).toBe('taken');
    expect(sent()).toEqual(['coil']);

    expect(control.takeRow(rowOf('block'))).toBe('ignored');
    expect(control.takeRow(rowOf('skin'))).toBe('ignored');
    expect(control.takeRow(rowOf('datum'))).toBe('ignored');
    expect(sent()).toEqual(['coil']);
  });

  it('ignores a face', () => {
    const { control, sent } = mount('curve');
    expect(control.takeClick('block-solid', face(1))).toBe('ignored');
    expect(sent()).toEqual([]);
  });

  it('lights a curve object\'s wires and a picked edge', () => {
    const { control } = mount('curve');
    control.takeClick('rail-wire', edge());
    control.takeClick('ring-wire', { type: 'sketch', index: 0 });
    control.takeClick('block-solid', edge(4));
    expect(control.highlight()).toEqual({
      entities: [{ shapeId: 'block-solid', sub: { type: 'edge', index: 4 } }],
      wireIds: ['rail-wire', 'ring-wire'],
      shapeIds: [],
    });
  });
});

describe('OperandSlotControl — a surface row', () => {
  it('arms faces only', () => {
    const { control } = mount('surface');
    expect(control.channels()).toMatchObject({ pickFilter: 'face', sketchWires: false });
  });

  it('takes the whole surface for a click on its face, and the face for a click on a solid\'s', () => {
    const { control, chips, sent } = mount('surface');
    expect(control.takeClick('skin-surface', face(2))).toBe('taken');
    expect(control.takeClick('block-solid', face(5))).toBe('taken');

    expect(chips()).toEqual(['Loft 1', 'Picked face']);
    expect(sent()).toEqual(['skin', { shapeId: 'block-solid', sub: { type: 'face', index: 5 } }]);
  });

  it('tells a surface from a solid inside one object: its surface is the object, its solid\'s face a face', () => {
    const { control, sent } = mount('surface');
    expect(control.takeClick('twin-surface', face(0))).toBe('taken');
    expect(control.takeClick('twin-solid', face(1))).toBe('taken');
    expect(sent()).toEqual(['twin', { shapeId: 'twin-solid', sub: { type: 'face', index: 1 } }]);
  });

  it('takes the timeline row of an object holding a surface, and no other', () => {
    const { control, sent } = mount('surface');
    expect(control.takeRow(rowOf('skin'))).toBe('taken');
    expect(control.takeRow(rowOf('twin'))).toBe('taken');
    expect(control.takeRow(rowOf('block'))).toBe('ignored');
    expect(control.takeRow(rowOf('coil'))).toBe('ignored');
    expect(control.takeRow(rowOf('sk'))).toBe('ignored');
    expect(sent()).toEqual(['skin', 'twin']);
  });

  it('ignores an edge', () => {
    const { control, sent } = mount('surface');
    expect(control.takeClick('skin-surface', edge(0))).toBe('ignored');
    expect(sent()).toEqual([]);
  });

  it('names a surface after the variable its statement is bound to, asked of any callee', async () => {
    const asked: { route: string; body: { lines: number[]; callee: string } }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      asked.push({ route: String(url), body });
      return { ok: true, json: async () => ({ names: body.lines.map((line: number) => line === 8 ? 'wing' : null) }) };
    }));
    const { control, chips } = mount('surface');
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(asked).toEqual([{ route: 'api/sketch-names', body: { lines: [8, 9], callee: 'any' } }]);
    control.takeClick('skin-surface', face(2));
    control.takeClick('twin-surface', face(0));
    // An unbound statement keeps its timeline name.
    expect(chips()).toEqual(['wing', 'Mirror 1']);
  });

  it('lights every body and curve a whole object holds', () => {
    const { control } = mount('surface');
    control.takeRow(rowOf('twin'));
    control.takeClick('block-solid', face(5));
    expect(control.highlight()).toEqual({
      entities: [{ shapeId: 'block-solid', sub: { type: 'face', index: 5 } }],
      wireIds: [],
      shapeIds: ['twin-surface', 'twin-solid', 'twin-trace'],
    });
  });
});

describe('OperandSlotControl — the slot', () => {
  it('a single slot swaps a new pick in, and the chip\'s ✕ empties it', () => {
    const { control, chips, text, remove, sent } = mount('curve', false);
    const changes: number[] = [];
    control.onChange = () => changes.push(1);

    control.takeClick('coil-edge', edge());
    control.takeClick('rail-wire', edge());
    expect(chips()).toEqual(['Copy 1']);
    expect(sent()).toEqual(['rail']);
    // Picks routed in fire nothing: the service that routed them repaints.
    expect(changes).toEqual([]);

    remove(0);
    expect(sent()).toEqual([]);
    expect(changes).toEqual([1]);
    expect(text()).toContain('Pick curves or edges');
  });

  it('a click on the slot arms it', () => {
    const { host, control } = mount('curve');
    let armed = 0;
    control.onArm = () => { armed++; };
    host.click();
    expect(armed).toBe(1);
  });

  it('re-finds whole objects after a render and drops the entities it minted', () => {
    const { control, sent } = mount('curve');
    control.takeClick('coil-edge', edge());
    control.takeClick('block-solid', edge(4));

    expect(control.setScene(scene('-2'))).toBe(true);
    expect(sent()).toEqual(['coil']);
    expect(control.highlight().wireIds).toEqual(['coil-edge-2']);

    // A statement the scene no longer holds drops with it.
    expect(control.setScene(scene('-3').filter(o => o.id !== 'coil'))).toBe(true);
    expect(sent()).toEqual([]);
    expect(control.setScene(scene('-4'))).toBe(false);
  });

  it('refuses a sketch with nothing drawn in it', () => {
    const { control, sent } = mount('curve');
    const empty = row({ id: 'blank', type: 'sketch', name: 'Sketch 2', isContainer: true }, 20);
    control.setScene([...scene(), empty]);
    expect(control.takeRow(empty)).toEqual({ message: 'Nothing is drawn in "Last Sketch" yet.' });
    expect(sent()).toEqual([]);
  });
});

describe('OperandSlotControl — an edit', () => {
  const statement = (line: number) => ({ kind: 'sketch' as const, filePath: FILE, line, column: 0 });

  it('opens on the statement\'s own argument, kept as written', () => {
    const { control, chips, sent } = mount('curve');
    control.seedKeep(['spring', 'rail'], [statement(6), statement(7)]);
    expect(chips()).toEqual(['Current: spring', 'Current: rail']);
    expect(sent()).toBe('keep');
    // The kept chips light what they resolved to.
    expect(control.highlight().wireIds).toEqual(['coil-edge', 'rail-wire']);
  });

  it('a pick replaces a kept argument it cannot start from', () => {
    const { control, chips, remove, sent } = mount('curve');
    control.seedKeep(['pickPath(a, b)'], [{ kind: 'opaque' }]);
    expect(chips()).toEqual(['Current: pickPath(a, b)']);

    control.takeClick('coil-edge', edge());
    expect(chips()).toEqual(['Helix 1']);
    expect(sent()).toEqual(['coil']);

    // Removing the pick goes back to the statement's own.
    remove(0);
    expect(chips()).toEqual(['Current: pickPath(a, b)']);
    expect(sent()).toBe('keep');
  });

  it('a single slot\'s pick replaces its kept chip', () => {
    const { control, chips, sent } = mount('surface', false);
    control.seedKeep(['skin'], [statement(8)]);
    expect(chips()).toEqual(['Current: skin']);

    control.takeClick('twin-surface', face(0));
    expect(chips()).toEqual(['Mirror 1']);
    expect(sent()).toEqual(['twin']);
    // Picking it again undoes the pick.
    control.takeClick('twin-surface', face(0));
    expect(sent()).toBe('keep');
  });

  it('a list whose kept elements all resolved starts its picks from them', () => {
    const { control, chips, sent } = mount('curve');
    control.seedKeep(
      ['spring', 'select(edge().onPlane("xy"))'],
      [statement(6), { kind: 'entities', entities: [{ shapeId: 'block-solid', sub: { type: 'edge', index: 4 } }] }],
    );

    // One more: the statement's own stay, as picks.
    control.takeClick('rail-wire', edge());
    expect(chips()).toEqual(['Helix 1', 'Picked edge', 'Copy 1']);
    expect(sent()).toEqual(['coil', { shapeId: 'block-solid', sub: { type: 'edge', index: 4 } }, 'rail']);

    // A click on one the statement has takes it off.
    control.takeClick('coil-edge', edge());
    expect(sent()).toEqual([{ shapeId: 'block-solid', sub: { type: 'edge', index: 4 } }, 'rail']);
  });

  it('takes what the engine resolved the kept argument to, once it answers, without dropping the row\'s picks', () => {
    const { control, sent } = mount('surface');
    const blockFace = { shapeId: 'block-solid', sub: { type: 'face' as const, index: 5 } };
    control.seedKeep(['skin', 'e.sideFaces()']);
    expect(control.highlight()).toEqual({ entities: [], wireIds: [], shapeIds: [] });

    control.setKeepRefs([statement(8), { kind: 'entities', entities: [blockFace] }]);
    expect(sent()).toBe('keep');
    expect(control.highlight()).toEqual({ entities: [blockFace], wireIds: [], shapeIds: ['skin-surface'] });

    // Every element resolved now: a pick adds to them.
    control.takeClick('twin-surface', face(0));
    expect(sent()).toEqual(['skin', blockFace, 'twin']);

    // A later answer leaves what the row holds alone.
    control.setKeepRefs([{ kind: 'opaque' }, { kind: 'opaque' }]);
    expect(sent()).toEqual(['skin', blockFace, 'twin']);
  });

  it('a fresh create forgets the kept argument', () => {
    const { control, chips, sent } = mount('curve');
    control.seedKeep(['spring'], [statement(6)]);
    control.reset();
    expect(chips()).toEqual([]);
    expect(sent()).toEqual([]);
  });
});
