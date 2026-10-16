// The shapes panel's hidden and transparency state is keyed by lineage, not
// by the shape ids a render mints: a hidden body stays hidden after an
// upstream edit rebuilds every holder, after a fillet moves it to a new
// holder, after a split branches it, and after its statement moves along its
// line. A shape with no lineage (a non-solid) is keyed by its id and lives
// one render, as before.
import { describe, expect, it } from 'vitest';
import { LineageShapeState } from '../src/scene/shape-state';
import type { SceneObjectRender } from '../src/types';

const FILE = '/ws/bracket.fluid.js';
const ROOT = `extrude@${FILE}:2:0`;

type Part = { shapeId: string; lineageKey?: string; isMetaShape?: boolean };

function row(id: string, parts: Part[]): SceneObjectRender {
  return {
    id, name: 'Extrude 1', type: 'extrude', uniqueType: 'extrude', parentId: null,
    sceneShapes: parts.map(p => ({ ...p, meshes: [], shapeType: p.lineageKey ? 'solid' : 'edge' })) as any,
    ownShapes: [],
  } as unknown as SceneObjectRender;
}

const solid = (shapeId: string, lineageKey: string): Part => ({ shapeId, lineageKey });

describe('LineageShapeState.parseRoot', () => {
  it('parses an unnamed call-site root with its body suffix', () => {
    expect(LineageShapeState.parseRoot(`${ROOT}:1`)).toEqual({ type: 'extrude', filePath: FILE, line: 2, column: 0, rest: ':1' });
    expect(LineageShapeState.parseRoot(`${ROOT}#1:2.1`)).toEqual({ type: 'extrude', filePath: FILE, line: 2, column: 0, rest: '#1:2.1' });
    expect(LineageShapeState.parseRoot(`cut@C:\\ws\\a.fluid.js:12:4:1.2.1`))
      .toEqual({ type: 'cut', filePath: 'C:\\ws\\a.fluid.js', line: 12, column: 4, rest: ':1.2.1' });
  });

  it('has no root for named, id-keyed and shape-keyed entries', () => {
    expect(LineageShapeState.parseRoot('name:bracket:1')).toBeNull();
    expect(LineageShapeState.parseRoot('name:a@b:1')).toBeNull();
    expect(LineageShapeState.parseRoot('id:obj-7:1')).toBeNull();
    expect(LineageShapeState.parseRoot('shape:abc')).toBeNull();
  });
});

describe('LineageShapeState.carryKeys', () => {
  it('keeps a present key, carries a vanished one to its branches, drops the rest', () => {
    const present = new Set([`${ROOT}:1.1`, `${ROOT}:1.2`, 'name:lid:1', `${ROOT}:12`]);
    const carried = LineageShapeState.carryKeys(new Set(['name:lid:1', `${ROOT}:1`, 'name:gone:1', 'shape:x']), present);
    expect(carried.get('name:lid:1')).toEqual(['name:lid:1']);
    expect(carried.get(`${ROOT}:1`)).toEqual([`${ROOT}:1.1`, `${ROOT}:1.2`]);
    expect(carried.get('name:gone:1')).toEqual([]);
    expect(carried.get('shape:x')).toEqual([]);
  });

  it('carries an unnamed root along its line to the new column, same body only', () => {
    const present = new Set([`extrude@${FILE}:2:10:1`, `extrude@${FILE}:2:10:2`, `cut@${FILE}:2:10:1`, `extrude@${FILE}:3:0:1`]);
    expect(LineageShapeState.carryKeys(new Set([`${ROOT}:1`]), present).get(`${ROOT}:1`)).toEqual([`extrude@${FILE}:2:10:1`]);
    expect(LineageShapeState.carryKeys(new Set([`${ROOT}#1:1`]), present).get(`${ROOT}#1:1`)).toEqual([]);
  });
});

describe('LineageShapeState', () => {
  it('keys a solid by lineage and anything else by shape id', () => {
    const state = new LineageShapeState();
    state.index([row('e', [solid('s1', `${ROOT}:1`), { shapeId: 'w1' }, { shapeId: 'm1', isMetaShape: true }])]);
    expect(state.keyOf('s1')).toBe(`${ROOT}:1`);
    expect(state.keyOf('w1')).toBe('shape:w1');
    expect(state.keyOf('m1')).toBe('shape:m1');
    expect(state.shapeIdsSharing('s1')).toEqual(['s1']);
    expect(state.shapeIdsSharing('m1')).toEqual(['m1']);
  });

  it('keeps a hidden body hidden when every shape id changes but the lineage keys do not', () => {
    const state = new LineageShapeState();
    state.index([row('e', [solid('s1', `${ROOT}:1`)]), row('f', [solid('s2', `${ROOT}:2`)])]);
    state.setHidden('s1', true);
    expect(state.isHidden('s1')).toBe(true);

    state.adopt([row('e2', [solid('n1', `${ROOT}:1`)]), row('f2', [solid('n2', `${ROOT}:2`)])]);
    expect(state.isHidden('n1')).toBe(true);
    expect(state.isHidden('n2')).toBe(false);
    expect(state.hiddenShapeIds()).toEqual(new Set(['n1']));
    expect(state.isHidden('s1')).toBe(false);
  });

  it('keeps a hidden body hidden through a fillet (new holder, same key)', () => {
    const state = new LineageShapeState();
    state.index([row('e', [solid('s1', `${ROOT}:1`)])]);
    state.setHidden('s1', true);

    state.adopt([row('e', []), row('fillet', [solid('f1', `${ROOT}:1`)])]);
    expect(state.isHidden('f1')).toBe(true);
    expect(state.hiddenShapeIds()).toEqual(new Set(['f1']));
  });

  it('carries a hidden body to both halves of a split, and its opacity too', () => {
    const state = new LineageShapeState();
    state.index([row('e', [solid('s1', `${ROOT}:1`)])]);
    state.setHidden('s1', true);
    state.setOpacity('s1', 0.4);

    state.adopt([row('e', []), row('split', [solid('a', `${ROOT}:1.1`), solid('b', `${ROOT}:1.2`)])]);
    expect(state.hiddenShapeIds()).toEqual(new Set(['a', 'b']));
    expect(state.opacityOf('a')).toBe(0.4);
    expect(state.opacityOf('b')).toBe(0.4);
    expect([...state.hiddenKeys()]).toEqual([`${ROOT}:1.1`, `${ROOT}:1.2`]);
  });

  it('carries state along the line when the statement moves to a new column', () => {
    const state = new LineageShapeState();
    state.index([row('e', [solid('s1', `${ROOT}:1`)])]);
    state.setHidden('s1', true);
    state.setOpacity('s1', 0.25);

    state.adopt([row('e', [solid('n1', `extrude@${FILE}:2:4:1`)])]);
    expect(state.isHidden('n1')).toBe(true);
    expect(state.opacityOf('n1')).toBe(0.25);
    expect(state.opacityByShapeId()).toEqual(new Map([['n1', 0.25]]));
  });

  it('keeps a present key its own opacity over one carried onto it', () => {
    const state = new LineageShapeState();
    state.index([row('e', [solid('s1', `${ROOT}:1`)]), row('g', [solid('s2', `${ROOT}:1.1`)])]);
    state.setOpacity('s1', 0.5);
    state.setOpacity('s2', 0.8);

    state.adopt([row('g', [solid('s2', `${ROOT}:1.1`), solid('s3', `${ROOT}:1.2`)])]);
    expect(state.opacityOf('s2')).toBe(0.8);
    expect(state.opacityOf('s3')).toBe(0.5);
  });

  it('prunes a shape-keyed non-solid once it is gone, and a named root that vanished', () => {
    const state = new LineageShapeState();
    state.index([row('e', [{ shapeId: 'w1' }, solid('s1', 'name:lid:1')])]);
    state.setHidden('w1', true);
    state.setHidden('s1', true);
    state.setOpacity('w1', 0.3);

    state.adopt([row('e', [{ shapeId: 'w2' }, solid('s2', 'name:lid:1')])]);
    expect(state.isHidden('w2')).toBe(false);
    expect(state.isHidden('s2')).toBe(true);
    expect(state.opacityOf('w2')).toBe(1);

    state.adopt([row('e', [solid('s3', 'name:base:1')])]);
    expect(state.hiddenKeys().size).toBe(0);
    expect(state.hiddenShapeIds().size).toBe(0);
  });

  it('reset-all clears every opacity and names the faded shapes of this render', () => {
    const state = new LineageShapeState();
    state.index([row('e', [solid('s1', `${ROOT}:1`), { shapeId: 'w1' }])]);
    state.setOpacity('s1', 0.5);
    state.setOpacity('w1', 0.2);
    state.setHidden('s1', true);
    expect(state.hasOpacities()).toBe(true);

    expect(state.clearOpacities().sort()).toEqual(['s1', 'w1']);
    expect(state.hasOpacities()).toBe(false);
    expect(state.opacityOf('s1')).toBe(1);
    expect(state.isHidden('s1')).toBe(true);
    expect(state.clearOpacities()).toEqual([]);
  });

  it('shows a body again under its key, and treats an opacity of 1 as cleared', () => {
    const state = new LineageShapeState();
    state.index([row('e', [solid('s1', `${ROOT}:1`)])]);
    state.setHidden('s1', true);
    state.setHidden('s1', false);
    state.setOpacity('s1', 0.5);
    state.setOpacity('s1', 1);
    expect(state.hiddenKeys().size).toBe(0);
    expect(state.opacityKeys().size).toBe(0);
  });
});
