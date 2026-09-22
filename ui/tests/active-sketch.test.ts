import { describe, it, expect } from 'vitest';
import { findActiveObject, findActiveSketch } from '../src/helpers/scene-utils';
import { collectSketchProfiles } from '../src/interactive/create-feature/sketch-profiles';
import type { SceneObjectRender } from '../src/types';

const loc = (line: number) => ({ filePath: '/ws/model.fluid.js', line, column: 1 });

function sketchRow(id: string, line: number, extra: Partial<SceneObjectRender> = {}): SceneObjectRender {
  return {
    id, name: 'sketch', parentId: null, isContainer: true, type: 'sketch', uniqueType: 'sketch',
    object: { plane: { origin: [0, 0, 0], normal: [0, 0, 1] } },
    sceneShapes: [{ shapeId: `${id}-w`, shapeType: 'wire', isMetaShape: false, isGuide: false, meshes: [{}] } as any],
    ownShapes: [], visible: true, sourceLocation: loc(line), ...extra,
  } as SceneObjectRender;
}

function extrudeRow(id: string, line: number): SceneObjectRender {
  return {
    id, name: 'extrude', parentId: null, isContainer: false, type: 'extrude', uniqueType: 'extrude',
    object: {}, sceneShapes: [{ shapeId: `${id}-s`, shapeType: 'solid', isMetaShape: false, isGuide: false } as any],
    ownShapes: [], visible: true, sourceLocation: loc(line),
  } as SceneObjectRender;
}

// Sketch mode is derived from the scene: the active scope's trailing sketch
// enters it — unless that sketch carries `.close()`, which finishes it
// without a consuming feature. Every sketch-mode site reads this one helper.
describe('findActiveSketch', () => {
  it('returns the trailing open sketch', () => {
    const scene = [extrudeRow('e1', 1), sketchRow('s2', 5)];
    expect(findActiveSketch(scene)?.id).toBe('s2');
  });

  it('reads a trailing closed sketch as no active sketch, though it still ends the scope', () => {
    const scene = [extrudeRow('e1', 1), sketchRow('s2', 5, { closed: true })];
    expect(findActiveObject(scene)?.id).toBe('s2');
    expect(findActiveSketch(scene)).toBeUndefined();
  });

  it('is undefined when the scope ends in a solid feature', () => {
    const scene = [sketchRow('s1', 1), extrudeRow('e2', 5)];
    expect(findActiveSketch(scene)).toBeUndefined();
  });

  it('offers a closed trailing sketch to feature dialogs as a plain profile, not the live one', () => {
    const open = collectSketchProfiles([sketchRow('s1', 1)]);
    expect(open.map(o => o.kind)).toEqual(['active']);
    const closed = collectSketchProfiles([sketchRow('s1', 1, { closed: true })]);
    expect(closed.map(o => o.kind)).toEqual(['other']);
  });
});
