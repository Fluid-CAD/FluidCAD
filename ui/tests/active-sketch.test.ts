import { afterEach, describe, it, expect } from 'vitest';
import { findActiveObject, findActiveSketch, setActivePartLocationProvider } from '../src/helpers/scene-utils';
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

function extrudeRow(id: string, line: number, extra: Partial<SceneObjectRender> = {}): SceneObjectRender {
  return {
    id, name: 'extrude', parentId: null, isContainer: false, type: 'extrude', uniqueType: 'extrude',
    object: {}, sceneShapes: [{ shapeId: `${id}-s`, shapeType: 'solid', isMetaShape: false, isGuide: false } as any],
    ownShapes: [], visible: true, sourceLocation: loc(line), ...extra,
  } as SceneObjectRender;
}

function partRow(id: string, line: number): SceneObjectRender {
  return {
    id, name: id, parentId: null, isContainer: true, type: 'part', uniqueType: 'part',
    object: {}, sceneShapes: [], ownShapes: [], visible: true, sourceLocation: loc(line),
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

// The active scope is the timeline's active part, or — no part active (a
// scene without parts, or the user stepped out of the one it has) — the
// file's top-level rows, parts included, in the timeline order the engine
// renders: a part at its part() call, a statement written after it below it.
describe('active scope at the top level', () => {
  afterEach(() => {
    setActivePartLocationProvider(() => null);
  });

  it('ends at a top-level statement written after the part', () => {
    const scene = [partRow('p1', 1), extrudeRow('e2', 2, { parentId: 'p1' }), sketchRow('s9', 9)];
    expect(findActiveObject(scene)?.id).toBe('s9');
    expect(findActiveSketch(scene)?.id).toBe('s9');
  });

  it('ends at the part row when the file ends in a part, past an open sketch above it', () => {
    const scene = [sketchRow('s1', 1), partRow('p3', 3), sketchRow('s4', 4, { parentId: 'p3' })];
    expect(findActiveObject(scene)?.id).toBe('p3');
    expect(findActiveSketch(scene)).toBeUndefined();
  });

  it('follows the active part while one is active', () => {
    setActivePartLocationProvider(() => loc(1));
    const scene = [partRow('p1', 1), sketchRow('s2', 2, { parentId: 'p1' }), sketchRow('s9', 9)];
    expect(findActiveSketch(scene)?.id).toBe('s2');
  });

  it('reads a top-level sketch a part body above it extruded as no active sketch', () => {
    // part(() => extrude(s)) written above `const s = sketch(...)`.
    const scene = [
      partRow('p1', 1),
      extrudeRow('e2', 2, { parentId: 'p1' }),
      sketchRow('s9', 9, { consumedBy: 'e2', visible: false }),
    ];
    expect(findActiveObject(scene)?.id).toBe('s9');
    expect(findActiveSketch(scene)).toBeUndefined();
  });
});
