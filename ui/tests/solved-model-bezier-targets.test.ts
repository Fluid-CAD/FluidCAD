import { describe, it, expect } from 'vitest';
import {
  bezierViewForShape, buildSolvedSketchModel, pickForEntity,
} from '../src/sketch-solver-client/model';
import type { SceneObjectRender } from '../src/types';

// A bezier is no solver entity: the entity→shape join never finds its
// curve, so a tool addressing a picked bezier resolves the statement from
// the model by the curve's shape id (the Mirror tool), and names its
// control points through the entity views the statement's anchors join as.

const PLANE = {
  origin: { x: 0, y: 0, z: 0 },
  normal: { x: 0, y: 0, z: 1 },
  xDirection: { x: 1, y: 0, z: 0 },
  yDirection: { x: 0, y: 1, z: 0 },
};
const CONTROLS: [number, number][] = [[0, 0], [10, 30], [50, 0]];
const LOC = { line: 7, column: 3, filePath: '/ws/m.fluid.js' };

function payload(): { sketch: SceneObjectRender; objects: SceneObjectRender[] } {
  const solver = {
    entities: [
      ...CONTROLS.map((_, i) => ({ id: i, kind: 'point', fixed: false, paramOffset: i * 2 })),
      { id: 3, kind: 'line', fixed: false, paramOffset: 6 },
    ],
    params: [...CONTROLS.flat(), 0, 0, 40, 0],
    constraints: [],
    dof: 10,
    outcome: 'solved',
    underconstrainedEntities: [0, 1, 2, 3],
  };
  const sketch = {
    id: 'sk', type: 'sketch', uniqueType: 'sketch',
    object: { solvedMode: true, plane: PLANE, solver }, sceneShapes: [], ownShapes: [],
  } as unknown as SceneObjectRender;
  const bezier = {
    id: 'bz1', parentId: 'sk', type: 'bezier', uniqueType: 'bezier-3', sourceLocation: LOC,
    object: {
      startPoint: CONTROLS[0],
      resolvedPoints: CONTROLS.slice(1),
      anchors: CONTROLS.map((p, i) => ({ pointIndex: i, entityId: i, guess: { x: p[0], y: p[1] } })),
      controlSources: CONTROLS.map((_, i) => ({ entityId: i, role: null })),
    },
    sceneShapes: [
      { shapeId: 'curve', shapeType: 'edge', meshes: [] },
      { shapeId: 'meta', shapeType: 'edge', meshes: [], isMetaShape: true },
    ],
    ownShapes: [],
  } as unknown as SceneObjectRender;
  const line = {
    id: 'l1', parentId: 'sk', type: 'line', uniqueType: 'solved-line',
    sourceLocation: { ...LOC, line: 6 },
    object: { entityId: 3, start: { x: 0, y: 0 }, end: { x: 40, y: 0 } },
    sceneShapes: [{ shapeId: 'line-edge', shapeType: 'edge', meshes: [] }],
    ownShapes: [],
  } as unknown as SceneObjectRender;
  return { sketch, objects: [sketch, bezier, line] };
}

describe('bezierViewForShape / pickForEntity', () => {
  const { sketch, objects } = payload();
  const model = buildSolvedSketchModel(sketch, objects)!;

  it('resolves the curve shape to its bezier statement, never a meta shape or an entity edge', () => {
    const view = bezierViewForShape(model, 'curve');
    expect(view?.obj.id).toBe('bz1');
    expect(view?.sources).toEqual(CONTROLS.map((_, i) => ({ entityId: i, role: null })));
    expect(bezierViewForShape(model, 'meta')).toBeUndefined();
    expect(bezierViewForShape(model, 'line-edge')).toBeUndefined();
    expect(bezierViewForShape(model, 'nope')).toBeUndefined();
  });

  it('names a control point through its anchor entity view — the bezier line + pointIndex', () => {
    const anchor = model.entities.get(1)!;
    expect(pickForEntity(model, anchor, null)).toEqual({
      entityId: 1, kind: 'point', sourceLocation: LOC, role: null,
      anchor: { owner: 'bezier', pointIndex: 1 },
    });
    const line = model.entities.get(3)!;
    expect(pickForEntity(model, line, 'end')).toEqual({
      entityId: 3, kind: 'line', sourceLocation: { ...LOC, line: 6 }, role: 'end',
    });
    expect(pickForEntity(model, line)).toEqual({
      entityId: 3, kind: 'line', sourceLocation: { ...LOC, line: 6 },
    });
  });
});
