import { describe, it, expect } from 'vitest';
import { SnapManager } from '../src/snapping/snap-manager';
import type { SceneObjectRender } from '../src/types';

// Solved-sketch snap provenance (sketch-rewrite P5): the snap manager builds
// vertex candidates from the solver payload — every entity vertex carries
// {line, role, featureType} so drawing tools can emit coincident()
// constraints, and closed-loop junctions snap (the degree-1 mesh scan could
// never surface them).

const PLANE = {
  origin: { x: 0, y: 0, z: 0 },
  center: null as any,
  normal: { x: 0, y: 0, z: 1 },
  xDirection: { x: 1, y: 0, z: 0 },
  yDirection: { x: 0, y: 1, z: 0 },
};

let nextId = 0;

function child(uniqueType: string, object: any): SceneObjectRender {
  nextId += 1;
  return {
    id: `obj-${nextId}`,
    parentId: 'sketch-1',
    type: uniqueType,
    uniqueType,
    object,
    sceneShapes: [],
    ownShapes: [],
    sourceLocation: { filePath: '/w/part.fluid.js', line: nextId + 10, column: 1 },
  } as SceneObjectRender;
}

function scene(): { objects: SceneObjectRender[]; lines: Record<string, number> } {
  nextId = 0;
  const sketch = {
    id: 'sketch-1',
    type: 'sketch',
    uniqueType: 'sketch',
    object: {
      plane: PLANE,
      solvedMode: true,
      solver: { entities: [], constraints: [], params: [], outcome: 'solved', dof: 0, conflicting: [], redundant: [], underconstrainedEntities: [] },
    },
    sceneShapes: [],
    ownShapes: [],
  } as SceneObjectRender;
  const l = child('solved-line', {
    entityId: 0,
    start: { x: 0, y: 0 }, end: { x: 40, y: 0 },
  });
  const c = child('solved-circle', {
    entityId: 1,
    center: { x: 100, y: 50 }, radius: 10,
  });
  const a = child('solved-arc', {
    entityId: 2,
    start: { x: 40, y: 0 }, end: { x: 60, y: 20 }, center: { x: 40, y: 20 },
  });
  return {
    objects: [sketch, l, c, a],
    lines: {
      line: l.sourceLocation!.line,
      circle: c.sourceLocation!.line,
      arc: a.sourceLocation!.line,
    },
  };
}

describe('solved snap provenance', () => {
  it('snapping a line endpoint carries its {line, role, featureType}', () => {
    const { objects, lines } = scene();
    const mgr = SnapManager.fromSceneObjects(objects, 'sketch-1', PLANE as any);
    const result = mgr.snap([39.5, 0.5], PLANE as any);
    expect(result.snapType).toBe('vertex');
    expect(result.point2d).toEqual([40, 0]);
    // The line's end and the arc's start share the position — the first
    // pushed candidate (the line's) wins the dedup, ref intact.
    expect(result.ref).toEqual({ line: lines.line, role: 'end', featureType: 'line' });
  });

  it('circle centers and arc centers are snappable with refs', () => {
    const { objects, lines } = scene();
    const mgr = SnapManager.fromSceneObjects(objects, 'sketch-1', PLANE as any);
    const centerSnap = mgr.snap([99.8, 50.2], PLANE as any);
    expect(centerSnap.ref).toEqual({ line: lines.circle, role: 'center', featureType: 'circle' });
    const arcCenter = mgr.snap([40.2, 19.8], PLANE as any);
    expect(arcCenter.ref).toEqual({ line: lines.arc, role: 'center', featureType: 'arc' });
  });

  it('a loop-instance vertex carries its occurrence in the ref', () => {
    const { objects, lines } = scene();
    // A second circle from the same looped statement line: only the
    // occurrence tells the instances apart.
    const looped = child('solved-circle', {
      entityId: 3,
      center: { x: 200, y: 50 }, radius: 10,
    });
    looped.sourceLocation!.line = lines.circle;
    looped.sourceLocation!.occurrence = 1;
    const mgr = SnapManager.fromSceneObjects([...objects, looped], 'sketch-1', PLANE as any);
    const snap = mgr.snap([199.8, 50.2], PLANE as any);
    expect(snap.ref).toEqual({
      line: lines.circle, occurrence: 1, role: 'center', featureType: 'circle',
    });
  });


  it("snapping an anchor point carries the owning statement's featureType (P8)", () => {
    nextId = 0;
    const sketch = {
      id: 'sketch-1',
      type: 'sketch',
      uniqueType: 'sketch',
      object: {
        plane: PLANE,
        solvedMode: true,
        solver: {
          entities: [
            { id: 0, kind: 'point', fixed: false, paramOffset: 0 },
            { id: 1, kind: 'point', fixed: false, paramOffset: 2 },
          ],
          constraints: [], params: [5, 7, 80, 30], outcome: 'solved',
          dof: 4, conflicting: [], redundant: [], underconstrainedEntities: [0, 1],
        },
      },
      sceneShapes: [],
      ownShapes: [],
    } as SceneObjectRender;
    const el = child('ellipse', {
      rx: 3, ry: 2, center: { x: 5, y: 7 },
      entityId: 0, guess: { center: { x: 5, y: 7 } },
    });
    const bz = child('bezier-3', {
      startPoint: [0, 0], resolvedPoints: [[40, 40], [80, 30]],
      anchors: [{ pointIndex: 2, entityId: 1, guess: { x: 80, y: 30 } }],
    });
    const mgr = SnapManager.fromSceneObjects([sketch, el, bz], 'sketch-1', PLANE as any);
    const centerSnap = mgr.snap([5.2, 6.9], PLANE as any);
    expect(centerSnap.ref).toEqual({ line: el.sourceLocation!.line, featureType: 'ellipse' });
    const cpSnap = mgr.snap([79.8, 30.1], PLANE as any);
    expect(cpSnap.ref).toEqual({
      line: bz.sourceLocation!.line, featureType: 'bezier', pointIndex: 2,
    });
  });

  it('a projected circle center snaps as a reference target on its producer statement', () => {
    // A bare `project(e.startEdges(5));` — the projected circle's center is
    // a fixed entity registered through the producer's `entities` join. The
    // snap ref must name the project() callee plus its `.ref(i)` address:
    // a plain `featureType: 'circle'` target on that line makes the server
    // refuse with "line N is not a sketch entity statement".
    nextId = 0;
    const solver = {
      entities: [
        { id: 0, kind: 'circle', fixed: true, paramOffset: 0 },
        { id: 1, kind: 'line', fixed: true, paramOffset: 3 },
        { id: 2, kind: 'line', fixed: false, paramOffset: 7 },
      ],
      constraints: [],
      params: [5, 7, 20, 60, 0, 60, 40, 30, -10, 30, 40],
      outcome: 'solved', dof: 4, conflicting: [], redundant: [], underconstrainedEntities: [],
    };
    const sketch = {
      id: 'sketch-1', type: 'sketch', uniqueType: 'sketch',
      object: { plane: PLANE, solvedMode: true, solver },
      sceneShapes: [], ownShapes: [],
    } as SceneObjectRender;
    const single = child('projection', {
      objectIds: [],
      entities: [{ entityId: 0, kind: 'circle', edgeIndex: 0 }],
      edgeCount: 1,
    });
    const multi = child('intersect', {
      objectIds: [],
      entities: [{ entityId: 1, kind: 'line', edgeIndex: 1 }],
      edgeCount: 2,
    });
    // Force the multi-edge address: the model renders `.ref(i)` only when
    // the producer registered more than one entity.
    (multi.object as any).entities.unshift({ entityId: 2, kind: 'line', edgeIndex: 0 });
    const mgr = SnapManager.fromSceneObjects([sketch, single, multi], 'sketch-1', PLANE as any);

    const center = mgr.snap([5.2, 6.8], PLANE as any);
    expect(center.snapType).toBe('vertex');
    expect(center.ref).toEqual({
      line: single.sourceLocation!.line, role: 'center', featureType: 'project', refIndex: null,
    });

    const end = mgr.snap([60.1, 39.9], PLANE as any);
    expect(end.ref).toEqual({
      line: multi.sourceLocation!.line, role: 'end', featureType: 'intersect', refIndex: 1,
    });
  });

  it('a 2D copy duplicate vertex snaps as an instance target on the copy() statement', () => {
    nextId = 0;
    const solver = {
      entities: [
        { id: 0, kind: 'line', fixed: false, paramOffset: 0 },
        { id: 5, kind: 'line', fixed: false, paramOffset: 4 },
      ],
      constraints: [],
      params: [0, 0, 10, 0, 0, 20, 10, 20],
      outcome: 'solved', dof: 8, conflicting: [], redundant: [], underconstrainedEntities: [],
    };
    const sketch = {
      id: 'sketch-1', type: 'sketch', uniqueType: 'sketch',
      object: { plane: PLANE, solvedMode: true, solver },
      sceneShapes: [], ownShapes: [],
    } as SceneObjectRender;
    const original = child('solved-line', { entityId: 0, start: { x: 0, y: 0 }, end: { x: 10, y: 0 } });
    const copy = child('copy-linear-2d', {
      sourceEntities: [0],
      sourcesSolved: true,
      entities: [{ entityId: 5, kind: 'line', slot: 1, shapeIndex: 0 }],
    });
    const mgr = SnapManager.fromSceneObjects([sketch, original, copy], 'sketch-1', PLANE as any);
    const dup = mgr.snap([9.9, 20.1], PLANE as any);
    expect(dup.ref).toEqual({
      line: copy.sourceLocation!.line, role: 'end', featureType: 'copy', instanceIndex: 1,
    });
  });

  it('grid/none snaps carry no ref', () => {
    const { objects } = scene();
    const mgr = SnapManager.fromSceneObjects(objects, 'sketch-1', PLANE as any);
    const free = mgr.snap([500, 500], PLANE as any);
    expect(free.ref).toBeUndefined();
  });
});
