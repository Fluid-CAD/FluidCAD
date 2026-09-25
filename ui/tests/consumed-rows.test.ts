// The rows a consumer hid (a sketch, plane or axis a feature used) can be
// drawn again: the timeline eye and the dialogs' reveal both go through the
// same "showable" rule and the same shown form of the row.
import { describe, it, expect } from 'vitest';
import { isShowableConsumedRow, rowWithHiddenShapes, withHiddenShapes } from '../src/helpers/scene-utils';
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
