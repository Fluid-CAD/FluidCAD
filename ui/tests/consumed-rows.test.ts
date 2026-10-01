// The rows a consumer hid (a sketch, plane or axis a feature used) can be
// drawn again: the timeline eye and the dialogs' reveal both go through the
// same "showable" rule and the same shown form of the row.
import { describe, it, expect } from 'vitest';
import { carryShownKeys, isShowableConsumedRow, rowWithHiddenShapes, sourceLocKey, withHiddenShapes } from '../src/helpers/scene-utils';
import type { SceneObjectRender } from '../src/types';

const loc = (line: number) => ({ filePath: '/ws/model.fluid.js', line, column: 1 });
const part = (shapeId: string) => ({ shapeId, shapeType: 'edge', isMetaShape: false, isGuide: false, meshes: [{}] } as any);

function row(id: string, type: string, over: Partial<SceneObjectRender> = {}): SceneObjectRender {
  return {
    id, name: type, parentId: null, isContainer: false, type, uniqueType: type,
    object: {}, sceneShapes: [], ownShapes: [], visible: true, sourceLocation: loc(1), ...over,
  } as SceneObjectRender;
}

describe('isShowableConsumedRow', () => {
  it('accepts a plane, axis or sketch a feature used', () => {
    expect(isShowableConsumedRow(row('p', 'plane', { visible: false, consumedBy: 's' }))).toBe(true);
    expect(isShowableConsumedRow(row('a', 'axis', { visible: false, consumedBy: 'r' }))).toBe(true);
    expect(isShowableConsumedRow(row('s', 'sketch', { visible: false, consumedBy: 'e', isContainer: true }))).toBe(true);
  });

  it('rejects a row still drawn, an internal object and a row without a source', () => {
    expect(isShowableConsumedRow(row('p', 'plane'))).toBe(false);
    expect(isShowableConsumedRow(row('p', 'plane', { visible: false, consumedBy: 's', internal: true }))).toBe(false);
    expect(isShowableConsumedRow(row('p', 'plane', { visible: false, consumedBy: 's', sourceLocation: undefined }))).toBe(false);
  });
});

describe('rowWithHiddenShapes', () => {
  it('draws the hidden quad of a used plane and reads visible', () => {
    const plane = row('p', 'plane', { visible: false, consumedBy: 's', hiddenShapes: [part('p-q')] });
    const shown = rowWithHiddenShapes(plane);
    expect(shown.visible).toBe(true);
    expect(shown.sceneShapes.map(s => s.shapeId)).toEqual(['p-q']);
    // The scene row itself is untouched.
    expect(plane.sceneShapes).toEqual([]);
  });

  it('returns the same row when nothing is hidden and it already draws', () => {
    const plane = row('p', 'plane', { sceneShapes: [part('p-q')] });
    expect(rowWithHiddenShapes(plane)).toBe(plane);
  });
});

describe('withHiddenShapes', () => {
  it('shows a sketch through its entity rows and leaves the other rows alone', () => {
    const sketch = row('s', 'sketch', { isContainer: true, visible: false, consumedBy: 'e' });
    const entity = row('c', 'circle', { parentId: 's', visible: false, hiddenShapes: [part('c-w')] });
    const other = row('e', 'extrude', { sceneShapes: [part('e-s')] });
    const shown = withHiddenShapes(sketch, [sketch, entity, other]);
    expect(shown[0].visible).toBe(true);
    expect(shown[1].sceneShapes.map(s => s.shapeId)).toEqual(['c-w']);
    expect(shown[2]).toBe(other);
  });
});

describe('carryShownKeys', () => {
  const at = (line: number, column: number) => ({ filePath: '/ws/model.fluid.js', line, column });
  const sketchAt = (id: string, line: number, column: number) =>
    row(id, 'sketch', { isContainer: true, visible: false, consumedBy: 'e', sourceLocation: at(line, column) });

  it('keeps the eye on a sketch an apply bound to a variable on its line', () => {
    // `sketch(…)` → `const s = sketch(…)`: same line, new column. The sketch's
    // own plane shares its call site and stays out of it.
    const prev = [row('p', 'plane', { internal: true, sourceLocation: at(23, 1) }), sketchAt('s', 23, 1)];
    const next = [row('p2', 'plane', { internal: true, sourceLocation: at(23, 11) }), sketchAt('s2', 23, 11)];
    expect([...carryShownKeys(new Set([sourceLocKey(at(23, 1))]), prev, next)]).toEqual([sourceLocKey(at(23, 11))]);
  });

  it('leaves a key alone when its row did not move or cannot be found', () => {
    const scene = [sketchAt('s', 23, 1)];
    const keys = new Set([sourceLocKey(at(23, 1)), '/ws/other.fluid.js:4:1']);
    expect(carryShownKeys(keys, scene, [sketchAt('s2', 23, 1)])).toEqual(keys);
    // A sketch on another line is not this row.
    const gone = new Set([sourceLocKey(at(23, 1))]);
    expect(carryShownKeys(gone, scene, [sketchAt('s2', 30, 11)])).toEqual(gone);
  });
});
