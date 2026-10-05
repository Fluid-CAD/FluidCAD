// An axis a feature used is consumed for display only: its row carries the
// consumer and the hidden line, and the axis picker offers it again, named
// after that consumer, with the hidden line as its pick and highlight target.
import { describe, it, expect } from 'vitest';
import { axisLineShapeIds, collectAxisOptions, resolveAxisByShapeId } from '../src/interactive/create-feature/axis-options';
import type { SceneObjectRender } from '../src/types';

const FILE = '/ws/model.fluid.js';
const loc = (line: number) => ({ filePath: FILE, line, column: 1 });
const line = (shapeId: string) => ({ shapeId, shapeType: 'edge', isMetaShape: true, isGuide: false, meshes: [{}] } as any);

function axisRow(id: string, at: number, over: Partial<SceneObjectRender> = {}): SceneObjectRender {
  return {
    id, name: 'axis', parentId: null, isContainer: false, type: 'axis', uniqueType: 'axis',
    object: {}, sceneShapes: [line(`${id}-l`)], ownShapes: [], visible: true, sourceLocation: loc(at), ...over,
  } as SceneObjectRender;
}

function revolveRow(id: string, at: number): SceneObjectRender {
  return {
    id, name: 'Revolve', parentId: null, isContainer: false, type: 'revolve', uniqueType: 'revolve',
    object: {}, sceneShapes: [], ownShapes: [], visible: true, sourceLocation: loc(at),
  } as SceneObjectRender;
}

const drawn = axisRow('a1', 2);
const used = axisRow('a2', 4, { visible: false, sceneShapes: [], hiddenShapes: [line('a2-l')], consumedBy: 'r1' });
const removed = axisRow('a3', 6, { visible: false, sceneShapes: [] });
const scene = [drawn, used, removed, revolveRow('r1', 5)];

describe('collectAxisOptions', () => {
  it('offers drawn axes plainly and used ones named after their consumer', () => {
    const options = collectAxisOptions(scene);
    expect(options.map(o => o.line)).toEqual([2, 4]);
    expect(options[0].label).toBe('Axis');
    expect(options[0].consumer).toBeUndefined();
    expect(options[1].label).toBe('Axis · used by Revolve');
    expect(options[1].consumer).toBe('Revolve');
  });

  it('leaves out an axis remove() took, which draws nothing hidden', () => {
    expect(collectAxisOptions(scene).some(o => o.line === 6)).toBe(false);
  });
});

describe('a used axis in the viewport', () => {
  it('resolves a click on its shown line', () => {
    expect(resolveAxisByShapeId('a2-l', scene)?.id).toBe('a2');
  });

  it('highlights its hidden line', () => {
    expect(axisLineShapeIds({ filePath: FILE, line: 4 }, scene)).toEqual(['a2-l']);
    expect(axisLineShapeIds({ filePath: FILE, line: 2 }, scene)).toEqual(['a1-l']);
  });
});
