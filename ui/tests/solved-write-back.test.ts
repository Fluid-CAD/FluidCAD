import { describe, it, expect } from 'vitest';
import { buildPositionWriteBack } from '../src/sketch-solver-client/write-back';
import type { LiveEntityGeometry } from '../src/sketch-solver-client/live-system';
import type { SolvedEntityView, SolvedSketchModel } from '../src/sketch-solver-client/model';

function view(
  entityId: number,
  kind: SolvedEntityView['kind'],
  fields: Partial<SolvedEntityView>,
  line: number,
): SolvedEntityView {
  return {
    entityId,
    kind,
    obj: {
      id: `obj-${entityId}`,
      sourceLocation: { filePath: '/ws/m.fluid.js', line, column: 3 },
    } as any,
    ...fields,
  };
}

function modelWith(entities: SolvedEntityView[]): SolvedSketchModel {
  return {
    sketch: {} as any,
    plane: {} as any,
    solver: null,
    entities: new Map(entities.map(e => [e.entityId, e])),
    beziers: new Map(),
    constraints: [],
    hasDatums: false,
    conflictingEntityIds: new Set(),
    constrainedEntityIds: new Set(),
    referenceProducers: new Map(),
    derivedProducers: new Map(),
    dof: null,
    outcome: null,
    fullyConstrained: false,
    conflictCount: 0,
    redundantCount: 0,
  };
}

describe('buildPositionWriteBack', () => {
  it('writes only drifted points, with role→index mapping and guards', () => {
    const model = modelWith([
      view(0, 'line', {
        start: [0, 0], end: [10, 0],
        guess: { start: [0, 0], end: [10, 0] },
      }, 5),
      view(1, 'arc', {
        start: [10, 0], end: [20, 10], center: [10, 10], radius: 10,
        guess: { start: [10, 0], end: [20, 10], center: [10, 10] },
      }, 6),
    ]);
    const live: Record<number, LiveEntityGeometry> = {
      0: { kind: 'line', start: [0, 0], end: [10.5051, 0.4949] },
      1: { kind: 'arc', start: [10.5051, 0.4949], end: [20, 10], center: [10.51, 10.49], radius: 10 },
    };
    const { edits, filePath } = buildPositionWriteBack(model, id => live[id]);
    expect(filePath).toBe('/ws/m.fluid.js');
    expect(edits).toEqual([
      { sourceLine: 5, points: [
        { pointIndex: 1, position: [10.51, 0.49], expected: [10, 0] },
      ] },
      { sourceLine: 6, points: [
        { pointIndex: 0, position: [10.51, 0.49], expected: [10, 0] },
        { pointIndex: 2, position: [10.51, 10.49], expected: [10, 10] },
      ] },
    ]);
  });

  it('produces no edits when nothing moved beyond 2dp resolution', () => {
    const model = modelWith([
      view(0, 'line', { start: [0, 0], end: [10, 0], guess: { start: [0, 0], end: [10, 0] } }, 5),
    ]);
    const { edits } = buildPositionWriteBack(model, () => ({
      kind: 'line', start: [0.001, -0.002], end: [10.004, 0],
    }));
    expect(edits).toEqual([]);
  });

  it('writes circle center and diameter with expected guards', () => {
    const model = modelWith([
      view(0, 'circle', {
        center: [50, 25], radius: 10,
        guess: { center: [50, 25], diameter: 20 },
      }, 7),
    ]);
    const { edits } = buildPositionWriteBack(model, () => ({
      kind: 'circle', center: [52, 25], radius: 12.25,
    }));
    expect(edits).toEqual([
      { sourceLine: 7,
        points: [{ pointIndex: 0, position: [52, 25], expected: [50, 25] }],
        scalar: { value: 24.5, expected: 20 } },
    ]);
  });

  it('skips entities without a guess payload or source location', () => {
    const noGuess = view(0, 'line', { start: [0, 0], end: [10, 0] }, 5);
    const noLoc = view(1, 'line', {
      start: [0, 5], end: [10, 5], guess: { start: [0, 5], end: [10, 5] },
    }, 6);
    (noLoc.obj as any).sourceLocation = undefined;
    const { edits } = buildPositionWriteBack(modelWith([noGuess, noLoc]), () => ({
      kind: 'line', start: [3, 3], end: [13, 3],
    }));
    expect(edits).toEqual([]);
  });

  it('point entities write pointIndex 0', () => {
    const model = modelWith([
      view(0, 'point', { point: [-10, -10], guess: { point: [-10, -10] } }, 9),
    ]);
    const { edits } = buildPositionWriteBack(model, () => ({ kind: 'point', point: [-12, -14] }));
    expect(edits).toEqual([
      { sourceLine: 9, points: [{ pointIndex: 0, position: [-12, -14], expected: [-10, -10] }] },
    ]);
  });

  it('anchor points write their statement chain-point index (P8)', () => {
    // A bezier's 3rd literal control point is its 3rd point-like argument;
    // ellipse/text anchors sit at index 0 of their own statements.
    const model = modelWith([
      view(0, 'point', {
        point: [100, 0], guess: { point: [100, 0] },
        anchor: { owner: 'bezier', pointIndex: 2 },
      }, 4),
      view(1, 'point', {
        point: [3, 4], guess: { point: [3, 4] },
        anchor: { owner: 'ellipse', pointIndex: 0 },
      }, 5),
    ]);
    const live: Record<number, LiveEntityGeometry> = {
      0: { kind: 'point', point: [104, 2] },
      1: { kind: 'point', point: [3, 4] },
    };
    const { edits } = buildPositionWriteBack(model, id => live[id]);
    expect(edits).toEqual([
      { sourceLine: 4, points: [{ pointIndex: 2, position: [104, 2], expected: [100, 0] }] },
    ]);
  });

  it('merges the drifted control points of one bezier into a single edit for its line', () => {
    // bezier([-17.61, 58.37], [-15, 30], [-35, 20], [-35.84, 3.8]) — four
    // anchor entities, one statement. A drag that moves several of them
    // must not name the line twice (the server refuses duplicate lines).
    const model = modelWith([
      view(0, 'point', { point: [-17.61, 58.37], guess: { point: [-17.61, 58.37] }, anchor: { owner: 'bezier', pointIndex: 0 } }, 19),
      view(1, 'point', { point: [-15, 30], guess: { point: [-15, 30] }, anchor: { owner: 'bezier', pointIndex: 1 } }, 19),
      view(2, 'point', { point: [-35, 20], guess: { point: [-35, 20] }, anchor: { owner: 'bezier', pointIndex: 2 } }, 19),
      view(3, 'point', { point: [-35.84, 3.8], guess: { point: [-35.84, 3.8] }, anchor: { owner: 'bezier', pointIndex: 3 } }, 19),
    ]);
    const live: Record<number, LiveEntityGeometry> = {
      0: { kind: 'point', point: [-17.61, 58.37] },
      1: { kind: 'point', point: [-12, 33] },
      2: { kind: 'point', point: [-35, 20] },
      3: { kind: 'point', point: [-30, 5] },
    };
    const { edits } = buildPositionWriteBack(model, id => live[id]);
    expect(edits).toEqual([
      { sourceLine: 19, points: [
        { pointIndex: 1, position: [-12, 33], expected: [-15, 30] },
        { pointIndex: 3, position: [-30, 5], expected: [-35.84, 3.8] },
      ] },
    ]);
  });

  it('writes an ellipse\'s drifted semi-radii and rotation, appending a missing rotation argument', () => {
    const model = modelWith([
      view(3, 'ellipse', {
        center: [0, 0], radii: [20, 10], theta: 0,
        guess: { center: [0, 0], rx: 20, ry: 10 },
      }, 12),
    ]);
    const live: LiveEntityGeometry = { kind: 'ellipse', center: [0, 0], radii: [25, 10.001], theta: Math.PI / 6 };
    const { edits } = buildPositionWriteBack(model, () => live);
    expect(edits).toEqual([{
      sourceLine: 12,
      radii: { rx: { value: 25, expected: 20 } },
      rotation: { value: 30 },
    }]);
  });
});
